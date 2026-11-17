// 거버넌스 저장소 PostgreSQL 구현 (사용자 결정 11/17, interfaces.md 10장, 스키마 hanaeum-terraform/db/migrations).
// DynamoRecords와 같은 계약. 문서 행 변환은 @hanaeum/db fromDocumentRow로만 (세 사람이 같은 모양).
import { db, fromDocumentRow, replaceStepFindings } from "@hanaeum/db";
import type { Db, Query } from "@hanaeum/db";
import type { Finding } from "@hanaeum/schemas";
import { DynamoRecords, normalizeDocument } from "./store.ts";
import type { ApprovalRecord, ConsumeArgs, Records } from "./store.ts";

const bindingError = (id: string) => Object.assign(new Error(`승인 바인딩 불일치 또는 재사용: ${id}`), { name: "ApprovalBindingError" });

export class PgRecords implements Records {
  private readonly q: Query;
  private readonly d?: Db;
  constructor(q: Query, d?: Db) { this.q = q; if (d) this.d = d; }
  async saveFindings(docId: string, step: string, findings: Finding[]) {
    // 문서 행 잠금 트랜잭션으로 그 단계 것만 교체 (@hanaeum/db, 병렬 단계 직렬화)
    const run = (q: Query) => replaceStepFindings(q, docId, step, findings as unknown as Parameters<typeof replaceStepFindings>[3]);
    if (this.d) await this.d.tx(run); else await run(this.q);
  }
  async getDocument(doc_id: string) {
    const [row] = await this.q("SELECT * FROM documents WHERE doc_id = :id", { id: doc_id });
    return row ? normalizeDocument(fromDocumentRow(row)) : undefined;
  }
  async getApproval(id: string) {
    const [row] = await this.q<ApprovalRecord>("SELECT * FROM approvals WHERE approval_id = :id", { id });
    return row;
  }
  async findApproval(docId: string, version: number, wf: string) {
    // APPROVED 먼저, 없으면 이 워크플로가 USED한 것(Promote 재시도)
    const [row] = await this.q<ApprovalRecord>(
      `SELECT * FROM approvals WHERE doc_id = :d AND version = :v AND (status = 'APPROVED' OR (status = 'USED' AND used_by = :wf))
       ORDER BY (status = 'APPROVED') DESC, created_at DESC LIMIT 1`, { d: docId, v: version, wf });
    return row;
  }
  async consumeApproval(a: ConsumeArgs) {
    // interfaces.md 7.1: APPROVED → USED 조건부 전환 1회. 같은 워크플로 재시도는 멱등
    const [row] = await this.q<ApprovalRecord>(
      `UPDATE approvals SET status = 'USED', used_by = :wf, used_at = COALESCE(used_at, now())
       WHERE approval_id = :id AND doc_id = :d AND version = :v AND content_hash = :h AND (status = 'APPROVED' OR (status = 'USED' AND used_by = :wf))
       RETURNING *`, { id: a.approval_id, d: a.doc_id, v: a.version, h: a.content_hash, wf: a.workflow_id });
    if (!row) throw bindingError(a.approval_id);
    return row;
  }
  async categoryPath(docId: string) {
    // 병합된 칸이면 병합 대상 칸의 경로 (ponytail: 한 단계만 따라감, 주기 정리가 문서를 옮기므로 보통 0단계)
    const [row] = await this.q<{ path: string }>(
      `SELECT COALESCE(m.path, c.path) AS path FROM documents d JOIN categories c ON c.category_id = d.category_id
       LEFT JOIN categories m ON m.category_id = c.merged_into WHERE d.doc_id = :id`, { id: docId });
    return row?.path;
  }
  async claimsCiting(prefix: string) {
    // prefix = "{law_id}@{revision_id}/" (법령 ID에 %·_가 없음, Trusted Registry 형식)
    return this.q<{ claim_id: string; provision_id: string }>(
      "SELECT claim_id, provision_id FROM claims WHERE status = 'CURRENT' AND provision_id LIKE :p", { p: `${prefix}%` });
  }
  async markClaimReview(claimId: string, reason: string) {
    await this.q("UPDATE claims SET status = 'REVIEW_REQUIRED', status_reason = :r, updated_at = now() WHERE claim_id = :id AND status = 'CURRENT'", { id: claimId, r: reason });
  }
  async setPublishedHash(docId: string, hash: string, at = new Date().toISOString()) {
    // published_at은 attrs(jsonb). 처음 게시할 때만 기록
    const rows = await this.q(
      `UPDATE documents SET published_content_hash = :h,
         attrs = CASE WHEN attrs ? 'published_at' THEN attrs ELSE attrs || jsonb_build_object('published_at', :t::text) END
       WHERE doc_id = :id RETURNING doc_id`, { id: docId, h: hash, t: at });
    if (!rows.length) throw new Error(`Documents 레코드 없음: ${docId}`);
  }
}

/** GOV_STORE=postgres면 PostgreSQL, 아니면 DynamoDB (전환 기간 롤백용). 단계 Lambda·Graph·Search가 같이 쓴다 */
export function recordsFromEnv(env: Record<string, string | undefined> = process.env): Records {
  if (env["GOV_STORE"] === "postgres") { const d = db({ resourceArn: env["DB_CLUSTER_ARN"], secretArn: env["DB_SECRET_ARN"], database: env["DB_NAME"] }); return new PgRecords(d.query, d); }
  const need = (k: string) => { const v = env[k]; if (!v) throw new Error(`환경변수 ${k} 없음`); return v; };
  return new DynamoRecords({ documents: need("TABLE_DOCUMENTS"), approvals: env["TABLE_APPROVALS"] ?? "" });
}
