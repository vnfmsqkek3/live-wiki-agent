// Trusted Registry 대조 입력 (단계 9 TrustGate, dhxorb96 apps/api/src/steps/trust-gate.ts 의 claimed·registry 형태 그대로).
// 1) 업로드 원본 해시가 Registry 원본 해시와 같으면 그 개정본 → VERIFIED 근거
// 2) 다르면 본문 머리말(법령명·시행일)로 "주장하는" 개정본을 찾고, 업로드 본문을 같은 조문 ID로 파싱해 조문 차이를 낼 수 있게 한다
//    (불일치 → REVIEW_REQUIRED. 위조 확정은 사람)
import { parseLaw } from "@hanaeum/legal-parser";
import { isoFromDotted, isoOfYmd, ymd } from "@hanaeum/schemas";
import { relPath } from "./store.ts";
import type { ClauseStore, RevisionRecord } from "./store.ts";

export interface RegistryEntry {
  law_id: string; law_name: string; revision_id: string; registry_doc_no?: string;
  /** 대조 기준 원본 해시 (PDF 기준본이 있으면 PDF, 없으면 텍스트 원본) */
  content_hash: string;
  effective_from: string; effective_to: string; // YYYY-MM-DD
  clauses: Record<string, string>; // 조문 경로(ARTICLE:12/PARAGRAPH:1) → 정규화 본문
}
export interface RegistryMatch {
  registry?: RegistryEntry;
  claimed?: { law_id: string; revision_id: string; clauses?: Record<string, string> };
}

const iso = isoOfYmd;
const clausesOf = async (store: ClauseStore, r: RevisionRecord) =>
  Object.fromEntries(((await store.provisions(r.law_id, r.revision_id)) ?? []).map((p) => [relPath(p.provision_id), p.normalized_text]));

async function entry(store: ClauseStore, r: RevisionRecord): Promise<RegistryEntry> {
  return {
    law_id: r.law_id, law_name: r.law_name, revision_id: r.revision_id, ...(r.registry_doc_no ? { registry_doc_no: r.registry_doc_no } : {}),
    content_hash: r.pdf_content_hash ?? r.content_hash, effective_from: iso(r.effective_from), effective_to: iso(r.effective_to),
    clauses: await clausesOf(store, r),
  };
}

/** 머리말 "시행일: 2026. 11. 1." → 20261101 */
const claimedDate = (head: string) => { const m = /시행일\s*[:：]\s*(\d{4}\.\s*\d{1,2}\.\s*\d{1,2})/u.exec(head); return m ? ymd(isoFromDotted(m[1]!)) : undefined; };

/** content_hash: 업로드 원본 바이트 sha256. text: 마스킹 본문 (해시 불일치일 때 주장 규정 추정용, 없으면 해시만 대조) */
export async function registryMatch(store: ClauseStore, content_hash: string, text?: string): Promise<RegistryMatch> {
  const hit = await store.revisionByHash(content_hash);
  if (hit) return { registry: await entry(store, hit), claimed: { law_id: hit.law_id, revision_id: hit.revision_id } };
  if (!text) return {};
  const head = text.split("\n").slice(0, 8).join("\n");
  const lawId = await store.lawIdByName(head);
  if (!lawId) return {};
  const revs = await store.revisions(lawId);
  const day = claimedDate(head);
  // 주장 시행일에 유효한 개정본, 시행일이 없으면 최신
  const rev = day ? revs.find((r) => r.effective_from <= day && day <= r.effective_to) : revs.sort((a, b) => b.effective_from - a.effective_from)[0];
  if (!rev) return { claimed: { law_id: lawId, revision_id: day ? iso(day) : "" } };
  const uploaded = parseLaw(text, { law_id: rev.law_id, law_name: rev.law_name, revision_id: rev.revision_id, effective_from: rev.effective_from });
  return {
    registry: await entry(store, rev),
    claimed: { law_id: rev.law_id, revision_id: rev.revision_id, clauses: Object.fromEntries(uploaded.provisions.map((p) => [relPath(p.provision_id), p.normalized_text])) },
  };
}
