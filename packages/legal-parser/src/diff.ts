// 버전 간 조항 Diff (docs/01 6장 Change Impact 첫 단계). 조문 경로(버전 접두 제외)로 대응시킨다.
import type { ParsedLaw } from "@hanaeum/schemas";

export interface ProvisionChange {
  path: string; // 버전 무관 경로, 예 ARTICLE:12/PARAGRAPH:1
  kind: "ADDED" | "REMOVED" | "MODIFIED" | "DELETED";
  old_id: string | null;
  new_id: string | null;
  old_text: string;
  new_text: string;
  numbers_changed: { old: string[]; new: string[] }; // 수치·금액 변화 (조건 변경 신호)
}

/** provision_id → 버전 무관 상대 경로 (LAW@REV/ 뒤) */
export const relPath = (id: string) => id.slice(id.indexOf("/") + 1);
const rel = relPath;
const NUM = /\d+(?:[.,]\d+)?\s*(?:억|만|천)?\s*(?:원|%|퍼센트|일|개월|년|회|배)?/gu;
// 띄어쓰기만 다른 조문은 개정이 아님 (prod 11/18: PDF·OCR 추출에서 "업종 집중도"↔"업종집중도"가 바뀌어 영향 문서로 잘못 잡힘)
const same = (a = "", b = "") => a.replace(/\s+/gu, "") === b.replace(/\s+/gu, "");
const nums = (s: string) => [...s.matchAll(NUM)].map((m) => m[0].replace(/\s+/gu, "")).filter((x) => /\D/u.test(x));

export function diffLaws(oldLaw: ParsedLaw, newLaw: ParsedLaw): ProvisionChange[] {
  const o = new Map(oldLaw.provisions.map((p) => [rel(p.provision_id), p]));
  const n = new Map(newLaw.provisions.map((p) => [rel(p.provision_id), p]));
  const out: ProvisionChange[] = [];
  for (const [path, np] of n) {
    const op = o.get(path);
    const base = { path, old_id: op?.provision_id ?? null, new_id: np.provision_id, old_text: op?.normalized_text ?? "", new_text: np.normalized_text };
    if (!op) out.push({ ...base, kind: "ADDED", numbers_changed: { old: [], new: nums(np.normalized_text) } });
    else if (np.status === "DELETED" && op.status !== "DELETED") out.push({ ...base, kind: "DELETED", numbers_changed: { old: nums(op.normalized_text), new: [] } });
    else if (!same(op.normalized_text, np.normalized_text) || !same(op.title, np.title)) {
      out.push({ ...base, kind: "MODIFIED", numbers_changed: { old: nums(op.normalized_text), new: nums(np.normalized_text) } });
    }
  }
  for (const [path, op] of o) if (!n.has(path)) {
    out.push({ path, kind: "REMOVED", old_id: op.provision_id, new_id: null, old_text: op.normalized_text, new_text: "", numbers_changed: { old: nums(op.normalized_text), new: [] } });
  }
  return out;
}
