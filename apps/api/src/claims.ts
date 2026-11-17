// 주장(Claim) 단위 지식 — 얇은 버전 (사용자 결정 11/17, interfaces.md 10.2, 스키마 007_claims.sql).
// 원본은 노하우 검증 결과(knowhow_validation.items) 그대로. 새 추출 없음. 답변·집계는 게시 문서의 주장만(JOIN).
import type { Query } from '@hanaeum/db';
import type { KnowhowValidation } from './steps/knowhow.ts';

export interface ClaimRow { claim_id: string; seq: number; statement: string; page: number | null; provision_id: string | null; relation: string; reason: string; quote: string | null; verified: boolean; status: string; status_reason: string | null }

/** 검증 결과로 그 문서의 주장을 교체: 같은 (doc_id, seq) 는 UPSERT(다시 CURRENT), 사라진 seq 는 SUPERSEDED. 한 트랜잭션 */
export async function saveClaims(tx: <T>(fn: (q: Query) => Promise<T>) => Promise<T>, doc_id: string, items: KnowhowValidation['items'], pageOf: (statement: string) => number | null = () => null) {
  return tx(async (q) => {
    for (const [i, it] of items.entries()) {
      await q(`INSERT INTO claims (claim_id, doc_id, seq, statement, page, provision_id, relation, reason, quote, verified, status, status_reason, checked_at, updated_at)
        VALUES (:id, :doc, :seq, :statement, :page, :prov, :relation, :reason, :quote, :verified, 'CURRENT', NULL, now(), now())
        ON CONFLICT (doc_id, seq) DO UPDATE SET statement = EXCLUDED.statement, page = EXCLUDED.page, provision_id = EXCLUDED.provision_id, relation = EXCLUDED.relation,
          reason = EXCLUDED.reason, quote = EXCLUDED.quote, verified = EXCLUDED.verified, status = 'CURRENT', status_reason = NULL, checked_at = now(), updated_at = now()`,
        { id: `${doc_id}#${i + 1}`, doc: doc_id, seq: i + 1, statement: it.statement.slice(0, 2000), page: pageOf(it.statement), prov: it.provision_id || null,
          relation: it.relation, reason: (it.reason ?? '').slice(0, 1000), quote: it.quote || null, verified: !!it.verified_quote });
    }
    await q(`UPDATE claims SET status = 'SUPERSEDED', status_reason = 'not_in_latest_validation', updated_at = now() WHERE doc_id = :doc AND seq > :n AND status <> 'SUPERSEDED'`, { doc: doc_id, n: items.length });
    return items.length;
  });
}

export const docClaims = (q: Query, doc_id: string) =>
  q<ClaimRow>(`SELECT claim_id, seq, statement, page, provision_id, relation, reason, quote, verified, status, status_reason FROM claims WHERE doc_id = :doc AND status <> 'SUPERSEDED' ORDER BY seq`, { doc: doc_id });

/** 조문마다 게시 문서 주장의 관계 수 (지지·보완·충돌·확인 필요) */
export async function provisionCounts(q: Query, provision_ids: string[]) {
  if (!provision_ids.length) return new Map<string, Record<string, number>>();
  const rows = await q<{ provision_id: string; relation: string; n: number }>(
    `SELECT c.provision_id, c.relation, count(*)::int AS n FROM claims c JOIN documents d ON d.doc_id = c.doc_id
     WHERE d.lifecycle = 'PUBLISHED' AND c.status <> 'SUPERSEDED' AND c.provision_id IN (SELECT jsonb_array_elements_text(:ids::jsonb)) GROUP BY c.provision_id, c.relation`,
    { ids: JSON.stringify(provision_ids) });
  const m = new Map<string, Record<string, number>>();
  for (const r of rows) m.set(r.provision_id, { ...(m.get(r.provision_id) ?? {}), [r.relation]: r.n });
  return m;
}

export const knowledgeDebt = async (q: Query) =>
  (await q<{ conflicts: number; review_required: number; unverified: number; healthy: number; docs_needing_attention: number }>('SELECT * FROM knowledge_debt'))[0]
  ?? { conflicts: 0, review_required: 0, unverified: 0, healthy: 0, docs_needing_attention: 0 };
