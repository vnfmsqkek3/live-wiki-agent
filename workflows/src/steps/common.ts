// yoyo0704 소유 단계(MalwareCheck, PageRender, OcrIfNeeded) 공통. 계약: interfaces.md 6장.
import { randomBytes } from "node:crypto";

export type Severity = "LOW" | "MEDIUM" | "HIGH";
export type Finding = { finding_id: string; step: string; severity: Severity; code: string; message: string; evidence_ref: string };
export type StepStatus = "OK" | "REVIEW_REQUIRED" | "BLOCKED" | "PENDING";
export type StepOutput = { status: StepStatus; output_key?: string; findings?: Finding[] };
export type StepInput = {
  workflow_id: string; doc_id: string; version: number; bucket: string; prefix: string;
  actor: { sub: string; groups: string[] };
};

// ULID (Crockford base32, 48bit ms + 80bit random).
// ponytail: Lambda zip 에 번들러 없이 넣으려고 직접 구현. packages/schemas 가 ID 헬퍼를 제공하면 교체.
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function ulid(now = Date.now()): string {
  let t = "";
  for (let i = 0, n = now; i < 10; i++, n = Math.floor(n / 32)) t = B32[n % 32] + t;
  const r = randomBytes(16);
  let s = "";
  for (let i = 0; i < 16; i++) s += B32[r[i]! % 32];
  return t + s;
}

export const finding = (step: string, severity: Severity, code: string, message: string, evidence_ref: string): Finding =>
  ({ finding_id: `fnd_${ulid()}`, step, severity, code, message, evidence_ref });
