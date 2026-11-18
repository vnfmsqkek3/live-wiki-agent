import type { ApprovalRecord, DocumentRecord, DraftRecord, FeedbackRecord } from './contracts.ts';
import { ApiError } from './errors.ts';

export interface AuditEvent {
  at: string;
  actor: string;
  action: string;
  resource: string;
  result: 'OK' | 'DENIED';
  trace_id: string;
  /** 원문·개인정보 없는 부가 정보 (예: WEB_SEARCH 검색어·URL·결과 수) */
  detail?: Record<string, unknown>;
}

/** DynamoDB 조건부 쓰기와 같은 의미를 지켜야 한다 (조건 불일치 → CONFLICT). */
export interface Store {
  getDoc(id: string): Promise<DocumentRecord | undefined>;
  putDoc(d: DocumentRecord): Promise<void>;
  listDocs(): Promise<DocumentRecord[]>;
  createApproval(a: ApprovalRecord): Promise<void>;
  getApproval(id: string): Promise<ApprovalRecord | undefined>;
  listApprovals(status: ApprovalRecord['status']): Promise<ApprovalRecord[]>;
  /** status=PENDING AND author≠approver AND 해시·버전 일치일 때만 전환 */
  decideApproval(id: string, next: { status: 'APPROVED' | 'REJECTED'; approver_sub: string; approver_name?: string; reason: string; s3_version_id: string; content_hash: string; /** 관리자 본인 문서 결재 (사용자 결정 11/18, 마이그레이션 008) */ self_approved?: boolean }): Promise<ApprovalRecord>;
  /** APPROVED → USED. Promote 직전 1회만 성공 */
  consumeApproval(id: string): Promise<ApprovalRecord>;
  putFeedback(f: FeedbackRecord): Promise<void>;
  putDraft(d: DraftRecord): Promise<void>;
  listDrafts(doc_id: string): Promise<DraftRecord[]>;
  audit(e: AuditEvent): Promise<void>;
}

// 메모리 구현: 단위 테스트·로컬 단독 실행용. 운영은 store-dynamo.ts
export function memoryStore() {
  const docs = new Map<string, DocumentRecord>();
  const approvals = new Map<string, ApprovalRecord>();
  const feedback = new Map<string, FeedbackRecord>();
  const drafts: DraftRecord[] = [];
  const audits: AuditEvent[] = [];
  const clone = <T>(v: T): T => structuredClone(v);

  const store: Store & { audits: AuditEvent[] } = {
    audits,
    async getDoc(id) { const d = docs.get(id); return d && clone(d); },
    async putDoc(d) { docs.set(d.doc_id, clone(d)); },
    async listDocs() { return [...docs.values()].map(clone); },
    async createApproval(a) {
      if (approvals.has(a.approval_id)) throw new ApiError('CONFLICT', 'approval exists');
      approvals.set(a.approval_id, clone(a));
    },
    async getApproval(id) { const a = approvals.get(id); return a && clone(a); },
    async listApprovals(status) { return [...approvals.values()].filter((a) => a.status === status).map(clone); },
    async decideApproval(id, n) {
      const a = approvals.get(id);
      if (!a) throw new ApiError('NOT_FOUND', 'approval not found');
      if (a.status !== 'PENDING') throw new ApiError('CONFLICT', 'approval is not pending');
      if ((a.author_sub === n.approver_sub) !== !!n.self_approved) throw new ApiError('FORBIDDEN', 'self approval is not allowed');
      if (a.s3_version_id !== n.s3_version_id || a.content_hash !== n.content_hash)
        throw new ApiError('CONFLICT', 'document changed after review');
      Object.assign(a, { status: n.status, approver_sub: n.approver_sub, ...(n.approver_name ? { approver_name: n.approver_name } : {}), reason: n.reason, decided_at: new Date().toISOString(), ...(n.self_approved ? { self_approved: true } : {}) });
      return clone(a);
    },
    async consumeApproval(id) {
      const a = approvals.get(id);
      if (!a || a.status !== 'APPROVED') throw new ApiError('CONFLICT', 'approval not usable');
      a.status = 'USED';
      return clone(a);
    },
    async putFeedback(f) { feedback.set(`${f.doc_id}#${f.user_sub}`, clone(f)); },
    async putDraft(d) { drafts.push(clone(d)); },
    async listDrafts(id) { return drafts.filter((d) => d.doc_id === id).map(clone); },
    async audit(e) { audits.push(e); },
  };
  return store;
}
