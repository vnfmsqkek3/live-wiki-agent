// yoyo0704 소유 단계(MalwareCheck, PageRender, OcrIfNeeded) 공통. 계약: interfaces.md 6장.
import { randomBytes } from "node:crypto";

export type Severity = "LOW" | "MEDIUM" | "HIGH";
// location·user_message·fix_hint: 올린 사람에게 "몇 쪽 어디가 왜 문제이고 어떻게 고치는지" 보여 주기 위한 필드 (사용자 요청 11/17).
// page 는 1부터. bbox 는 렌더 PNG 픽셀 [x0,y0,x1,y1]. excerpt 는 마스킹된 텍스트만(원문 금지)
export type FindingLocation = { page?: number; bbox?: number[][]; excerpt?: string };
export type Finding = {
  finding_id: string; step: string; severity: Severity; code: string; message: string; evidence_ref: string;
  location?: FindingLocation; user_message?: string; fix_hint?: string;
};
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

export const finding = (step: string, severity: Severity, code: string, message: string, evidence_ref: string,
  extra: Pick<Finding, "location" | "user_message" | "fix_hint"> = {}): Finding =>
  ({ finding_id: `fnd_${ulid()}`, step, severity, code, message, evidence_ref, ...extra });
