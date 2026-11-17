// 거버넌스 저장소 PostgreSQL 구현 (사용자 결정 11/17, interfaces.md 10장, 스키마 hanaeum-terraform/db/migrations).
// Store 의미는 DynamoDB 구현과 같다: 승인 결정·사용은 조건부 UPDATE … RETURNING (0행 → 재조회로 사유 분류).
// 문서 행 변환은 반드시 @hanaeum/db toDocumentRow/fromDocumentRow (세 사람이 같은 모양).
import { db as connect, fromDocumentRow, toDocumentRow, toFindingRow, UPSERT_DOCUMENT_SQL, type Db, type Params } from '@hanaeum/db';
import type { ApprovalRecord, DocumentRecord, DraftRecord, Finding } from './contracts.ts';
import { ApiError } from './errors.ts';
import type { Store } from './store.ts';

/** null 열은 키를 만들지 않는다 (DynamoDB 때와 같은 모양) */
const compact = <T>(row: Record<string, unknown>): T => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null && v !== undefined)) as T;
const json = (v: unknown) => JSON.stringify(v ?? []);

export interface PostgresStore extends Store {
  /** 보관함·홈: 본인 문서 (Scan 대신 owner 인덱스) */
  listDocsByOwner(owner: string): Promise<DocumentRecord[]>;
  /** 결재함·노하우 점검: 상태별 (lifecycle 인덱스) */
  listDocsByLifecycle(lifecycles: string[]): Promise<DocumentRecord[]>;
}

export function postgresStore(d: Db = connect()): PostgresStore {
  const q = d.query;
  /** 문서 행 + findings 행을 묶어 DocumentRecord로 */
  const withFindings = async (rows: Record<string, unknown>[]) => {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.doc_id as string);
    const fr = await q('SELECT * FROM findings WHERE doc_id = ANY(ARRAY(SELECT jsonb_array_elements_text(:ids::jsonb))) ORDER BY created_at, finding_id', { ids: json(ids) });
    const by = new Map<string, Record<string, unknown>[]>();
    for (const f of fr) (by.get(f.doc_id as string) ?? by.set(f.doc_id as string, []).get(f.doc_id as string)!).push(f);
    return rows.map((r) => fromDocumentRow<DocumentRecord>(r, by.get(r.doc_id as string) ?? []));
  };
  const getApproval = async (id: string) => {
    const [r] = await q('SELECT * FROM approvals WHERE approval_id = :id', { id });
    return r ? compact<ApprovalRecord>(r) : undefined;
  };

  return {
    getApproval,
    async getDoc(id) {
      return (await withFindings(await q('SELECT * FROM documents WHERE doc_id = :id', { id })))[0];
    },
    async putDoc(doc) {
      // 문서 전체 교체 + findings 동기화. 병렬 단계가 그 사이 넣은 다른 단계의 findings는 지우지 않는다
      // (이 문서가 가진 단계의 findings만 교체: lambdas.ts addFindings와 같은 단계 단위 의미)
      const findings = (doc.findings ?? []) as Finding[];
      const steps = [...new Set(findings.map((f) => f.step))];
      await d.tx(async (t) => {
        await t(UPSERT_DOCUMENT_SQL, toDocumentRow(doc as unknown as Record<string, unknown>) as Params);
        if (steps.length)
          await t(`DELETE FROM findings WHERE doc_id = :doc_id AND step = ANY(ARRAY(SELECT jsonb_array_elements_text(:steps::jsonb)))
            AND NOT (finding_id = ANY(ARRAY(SELECT jsonb_array_elements_text(:ids::jsonb))))`, { doc_id: doc.doc_id, steps: json(steps), ids: json(findings.map((f) => f.finding_id)) });
        for (const f of findings)
          await t(`INSERT INTO findings (finding_id, doc_id, step, severity, code, data) VALUES (:finding_id, :doc_id, :step, :severity, :code, :data::jsonb)
            ON CONFLICT (finding_id) DO UPDATE SET step = EXCLUDED.step, severity = EXCLUDED.severity, code = EXCLUDED.code, data = EXCLUDED.data`,
          toFindingRow(doc.doc_id, f as unknown as Finding & Record<string, unknown>) as Params);
      });
    },
    async listDocs() {
      return withFindings(await q('SELECT * FROM documents ORDER BY updated_at DESC'));
    },
    async listDocsByOwner(owner) {
      return withFindings(await q('SELECT * FROM documents WHERE owner = :owner ORDER BY updated_at DESC', { owner }));
    },
    async listDocsByLifecycle(ls) {
      return withFindings(await q('SELECT * FROM documents WHERE lifecycle = ANY(ARRAY(SELECT jsonb_array_elements_text(:ls::jsonb))) ORDER BY updated_at DESC', { ls: json(ls) }));
    },
    async createApproval(a) {
      const r = await q(`INSERT INTO approvals (approval_id, doc_id, version, s3_version_id, content_hash, author_sub, status, created_at)
        VALUES (:approval_id, :doc_id, :version, :s3_version_id, :content_hash, :author_sub, :status, :created_at::timestamptz)
        ON CONFLICT (approval_id) DO NOTHING RETURNING approval_id`, { ...a });
      if (!r.length) throw new ApiError('CONFLICT', 'approval exists');
    },
    async listApprovals(status) {
      return (await q('SELECT * FROM approvals WHERE status = :status ORDER BY created_at', { status })).map((r) => compact<ApprovalRecord>(r));
    },
    async decideApproval(id, n) {
      const [r] = await q(`UPDATE approvals SET status = :next, approver_sub = :ap, approver_name = :an, reason = :r, decided_at = now()
        WHERE approval_id = :id AND status = 'PENDING' AND author_sub <> :ap AND s3_version_id = :v AND content_hash = :h RETURNING *`,
      { id, next: n.status, ap: n.approver_sub, an: n.approver_name ?? null, r: n.reason, v: n.s3_version_id, h: n.content_hash });
      if (r) return compact<ApprovalRecord>(r);
      const cur = await getApproval(id); // 실패 사유 분류용 재조회 (DynamoDB 구현과 같은 오류)
      if (!cur) throw new ApiError('NOT_FOUND', 'approval not found');
      if (cur.status !== 'PENDING') throw new ApiError('CONFLICT', 'approval is not pending');
      if (cur.author_sub === n.approver_sub) throw new ApiError('FORBIDDEN', 'self approval is not allowed');
      throw new ApiError('CONFLICT', 'document changed after review');
    },
    async consumeApproval(id) {
      const [r] = await q("UPDATE approvals SET status = 'USED' WHERE approval_id = :id AND status = 'APPROVED' RETURNING *", { id });
      if (!r) throw new ApiError('CONFLICT', 'approval not usable');
      return compact<ApprovalRecord>(r);
    },
    async putFeedback(f) {
      await q(`INSERT INTO feedback (doc_id, user_sub, stars, useful, updated_at) VALUES (:doc_id, :user_sub, :stars, :useful, :updated_at::timestamptz)
        ON CONFLICT (doc_id, user_sub) DO UPDATE SET stars = EXCLUDED.stars, useful = EXCLUDED.useful, updated_at = EXCLUDED.updated_at`, { ...f, stars: f.stars ?? null });
    },
    async putDraft(x) {
      await q(`INSERT INTO drafts (draft_id, doc_id, base_version, proposed_text, basis, created_by, status, created_at)
        VALUES (:draft_id, :doc_id, :base_version, :proposed_text, ARRAY(SELECT jsonb_array_elements_text(:basis::jsonb)), :created_by, :status, :created_at::timestamptz)
        ON CONFLICT (draft_id) DO UPDATE SET proposed_text = EXCLUDED.proposed_text, basis = EXCLUDED.basis`, { ...x, basis: json(x.basis) });
    },
    async listDrafts(id) {
      return (await q('SELECT * FROM drafts WHERE doc_id = :id ORDER BY created_at', { id })).map((r) => compact<DraftRecord>(r));
    },
    async audit(e) {
      // 감사 기록은 추가만 (테이블 트리거가 수정·삭제를 막는다)
      await q('INSERT INTO audit_events (at, actor, action, resource, result, trace_id, detail) VALUES (:at::timestamptz, :actor, :action, :resource, :result, :trace_id, :detail::jsonb)', { ...e, detail: e.detail ? JSON.stringify(e.detail) : null });
    },
  };
}
