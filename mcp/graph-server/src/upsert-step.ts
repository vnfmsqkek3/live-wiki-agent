// 단계 13 GraphUpsert: 승인된 문서의 관계만 Neptune에 게시. 법령은 구조화 저장소(Regulations)에도 적재.
import { diffLaws, ISSUE_TEXT, parseLaw } from "@hanaeum/legal-parser";
import type { ProvisionChange } from "@hanaeum/legal-parser";
import { newId, stepFailure } from "@hanaeum/schemas";
import type { AuthorityStatus, Finding, ParsedLaw, StepInput, StepOutput } from "@hanaeum/schemas";
import type { ClauseStore, RevisionRecord } from "@hanaeum/regulation-server";
import { lawGraph, wikiGraph } from "./model.ts";
import type { Citation } from "./model.ts";
import type { GraphStore } from "./store.ts";
import { overlaps } from "./store.ts";
import { loadLaw } from "./tools.ts";

export interface GraphUpsertInput extends StepInput {
  document_type: "REGULATION" | "KNOWHOW" | "MANUAL";
  title: string; effective_from: number; effective_to: number;
  content: string; // published 마스킹본 본문 (핸들러가 S3에서 읽어 채움)
  content_hash: string; acl_groups: string[];
  authority_status: AuthorityStatus; // Documents 레코드의 현재 공식성 (하드코딩 금지)
  law?: { law_id: string; law_name: string; revision_id: string; previous_revision_id?: string; registry_doc_no?: string };
  citations?: Citation[]; // 승인 시 확정된 인용 (Trust Gate 후보 → 사람 승인)
}

export type WritableClauseStore = ClauseStore & {
  putLaw?(r: RevisionRecord, l: ReturnType<typeof parseLaw>): Promise<void>;
  closeRevision?(lawId: string, revisionId: string, effectiveTo: number): Promise<void>;
};

/** yyyymmdd 하루 전 */
export const dayBefore = (ymd: number) => {
  const d = new Date(Date.UTC(Math.floor(ymd / 10000), Math.floor(ymd / 100) % 100 - 1, ymd % 100) - 86400000);
  return Number(d.toISOString().slice(0, 10).replaceAll("-", ""));
};

/** 주장 상태 갱신 (interfaces 10.2). Records(PgRecords)의 선택 메서드 */
export interface ClaimStore {
  claimsCiting?(lawRevPrefix: string): Promise<{ claim_id: string; provision_id: string }[]>;
  markClaimReview?(claimId: string, reason: string): Promise<void>;
}

/** 공백·문장부호만 다른 변경은 무시 (OCR 본문과 이전 버전 본문의 사소한 차이로 대량 재검토되지 않게, PR #36 리뷰) */
const norm = (t: string) => t.normalize("NFC").replace(/[\s\p{P}\p{S}]/gu, "");
/** 한 개정에서 바뀐 조문이 이 비율을 넘으면 자동 표시를 멈추고 사람 확인을 요청 (본문 추출 이상 의심) */
const MASS_CHANGE = 0.5;
// SQLState 42P01(테이블 없음): 주장 스키마 배포 전. 규정 게시를 막지 않는다. 그 밖의 오류는 던져 단계 재시도
const missingTable = (e: unknown) => /42P01|relation "claims" does not exist/u.test(String((e as Error).message ?? ""));

/** 새 VERIFIED 버전이 게시되면, 그 법령의 더 이른 버전 조문에 근거를 둔 CURRENT 주장 중 내용이 바뀐 조문(겹치는 경로 포함)의 주장을 REVIEW_REQUIRED로.
 *  주장이 인용한 버전과 새 버전을 직접 비교한다 (중간 개정을 거쳐도 누락 없음). status_reason = "provision_revised:{새 버전 조문 경로}".
 *  ponytail: 시행일이 미래인 개정본을 게시한 뒤 저장되는 주장은 여기서 잡지 못함 → 주장 저장 쪽(노하우 검증)이 최신 VERIFIED 버전과 대조 */
export async function markRevisedClaims(law: ParsedLaw, clauses: WritableClauseStore, claims: ClaimStore): Promise<{ marked: number; held?: string[] }> {
  if (!claims.claimsCiting || !claims.markClaimReview) return { marked: 0 };
  let rows: { claim_id: string; provision_id: string }[];
  try { rows = await claims.claimsCiting(`${law.law_id}@`); } catch (e) {
    if (!missingTable(e)) throw e;
    console.warn(JSON.stringify({ msg: "claims 테이블 없음 → 주장 재검토 건너뜀", law_id: law.law_id }));
    return { marked: 0 };
  }
  if (!rows.length) return { marked: 0 };
  const all = await clauses.revisions(law.law_id);
  const revs = new Map(all.map((r) => [r.revision_id, r]));
  // 대량 변경(본문 인식 이상 의심)은 직전 개정본과 한 번만 판정한다. 오래된 버전과는 실제 차이가 커서 판정 기준으로 쓰지 않음 (PR #36 재리뷰)
  const prev = all.filter((r) => r.revision_id !== law.revision_id && r.effective_from < law.effective_from).sort((a, b) => b.effective_from - a.effective_from)[0];
  if (prev) {
    const old = await loadLaw(clauses, law.law_id, prev.revision_id);
    const ch = diffLaws(old, law).filter((x) => !x.path.startsWith("SUPPLEMENTARY:") && x.kind !== "ADDED" && norm(x.old_text) !== norm(x.new_text));
    if (old.provisions.length > 0 && ch.length / old.provisions.length > MASS_CHANGE) return { marked: 0, held: [`${law.law_id}@${prev.revision_id}`] };
  }
  const changesOf = new Map<string, ProvisionChange[]>();
  let marked = 0;
  for (const c of rows) {
    const m = /^[^@]+@([^/]+)\/(.+)$/u.exec(c.provision_id);
    if (!m) continue;
    const [, rev, path] = m as unknown as [string, string, string];
    const r = revs.get(rev);
    if (rev === law.revision_id || !r || r.effective_from >= law.effective_from) continue; // 같거나 더 새 버전 인용은 대상 아님
    if (!changesOf.has(rev)) {
      const old = await loadLaw(clauses, law.law_id, rev);
      changesOf.set(rev, diffLaws(old, law).filter((x) => !x.path.startsWith("SUPPLEMENTARY:") && norm(x.old_text) !== norm(x.new_text)));
    }
    const hit = changesOf.get(rev)!.find((x) => overlaps(path, x.path));
    if (!hit) continue;
    await claims.markClaimReview(c.claim_id, `provision_revised:${law.law_id}@${law.revision_id}/${hit.path}`);
    marked++;
  }
  return { marked };
}

export async function graphUpsertStep(input: GraphUpsertInput, graph: GraphStore, clauses: WritableClauseStore, claims: ClaimStore = {}): Promise<StepOutput> {
  if (input.document_type === "REGULATION") {
    if (!input.law) throw stepFailure("RegulationNotInRegistry", "공식 규정으로 분류됐지만 규정 정보(법령 ID·시행 버전)가 없어 조문 구조를 저장할 수 없습니다.", "공식 원본 PDF인지 확인하거나 분류를 '노하우'로 바꿔 다시 게시 요청해 주세요.");
    const law = parseLaw(input.content, { ...input.law, effective_from: input.effective_from });
    const lines = input.content.split("\n");
    // 게시본은 이미 마스킹된 본문이라 문장 일부를 그대로 안내에 쓴다 (쪽 경계는 게시본에 없음 → 문장으로 위치 안내)
    const findings: Finding[] = law.issues.map((i) => {
      const excerpt = (lines[i.line - 1] ?? "").trim().slice(0, 120);
      const msg = `"${excerpt.slice(0, 40)}" 부근: ${ISSUE_TEXT[i.code] ?? "조문 구조를 해석하지 못했습니다"}.`;
      return { finding_id: newId("fnd"), step: "GraphUpsert", severity: "MEDIUM", code: i.code, message: msg, evidence_ref: `line:${i.line}`,
        location: { excerpt }, user_message: msg, fix_hint: "조문 저장소에는 '구조 미확정'으로 저장했습니다(없는 조문을 '없음'으로 단정하지 않음). 원본을 고쳐 같은 버전으로 다시 올리면 바로잡힙니다." };
    });
    // 파싱 이슈가 있어도 사람 승인을 거친 게시라 저장한다 (yoyo0704 11/19: 안 쓰면 KB엔 있고 조문 저장소·그래프엔 없는 규정이 생김).
    // parse_ok=false 로 저장 → 조문 조회가 부재·과거 버전을 단정하지 않고 UNVERIFIED. 승인 전 안내는 SegmentBuild structureFindings
    // Trusted Registry 원본 해시(content_hash·pdf_content_hash)는 덮어쓰지 않는다. 덮어쓰면 같은 공식 원본을 다시 올릴 때
    // 해시 대조가 실패해 "공식 원본과 다름"으로 막힌다 (11/17 재업로드 실측: F-000·F-001 출처 불일치)
    const prev = (await clauses.revisions(law.law_id)).find((r) => r.revision_id === law.revision_id);
    const rec: RevisionRecord = {
      law_id: law.law_id, law_name: law.law_name, revision_id: law.revision_id, registry_doc_no: input.law.registry_doc_no ?? prev?.registry_doc_no,
      effective_from: input.effective_from, effective_to: input.effective_to, authority_status: input.authority_status,
      doc_id: input.doc_id, content_hash: prev?.content_hash || input.content_hash, ...(prev?.pdf_content_hash ? { pdf_content_hash: prev.pdf_content_hash } : {}),
      acl_groups: input.acl_groups, parse_ok: law.issues.length === 0,
    };
    if (clauses.putLaw) await clauses.putLaw(rec, law);
    // 새 VERIFIED 버전이 시행되면 겹치는 이전 버전의 종료일을 닫는다 (이전 버전이 현행으로 남지 않게)
    if (rec.authority_status === "VERIFIED" && clauses.closeRevision) {
      for (const r of await clauses.revisions(law.law_id)) {
        if (r.revision_id !== rec.revision_id && r.effective_from < rec.effective_from && r.effective_to >= rec.effective_from) {
          await clauses.closeRevision(law.law_id, r.revision_id, dayBefore(rec.effective_from));
        }
      }
    }
    await graph.upsert(lawGraph(law, { doc_id: input.doc_id, effective_from: input.effective_from, effective_to: input.effective_to, previous_revision_id: input.law.previous_revision_id }));
    // 개정본이면 바뀐 조문에 근거를 둔 노하우 주장을 재검토로 (사용자 결정 11/17 얇은 주장 단위, 요청기록 20261117-2300)
    // 구조가 일부만 해석된 버전과 비교하면 못 읽은 조문이 '삭제'로 보여 노하우를 잘못 재검토로 돌린다 → 이슈가 있으면 생략하고 알림
    if (rec.authority_status === "VERIFIED" && findings.length) findings.push({ finding_id: newId("fnd"), step: "GraphUpsert", severity: "LOW", code: "CLAIM_REVIEW_SKIPPED", message: `${law.law_id}@${law.revision_id}`, evidence_ref: `${law.law_id}@${law.revision_id}`,
      user_message: "조문 구조를 다 해석하지 못해, 이번 개정으로 바뀐 조문에 근거를 둔 노하우의 재검토 표시를 하지 않았습니다.", fix_hint: "원본을 고쳐 같은 버전으로 다시 올리면 재검토 표시가 실행됩니다. 그전까지 관련 노하우는 사람이 확인해 주세요." });
    else if (rec.authority_status === "VERIFIED") {
      const { held } = await markRevisedClaims({ ...law, effective_from: input.effective_from }, clauses, claims);
      // 대량 변경 보류: 게시는 계속하고, 노하우 재검토 표시는 사람이 확인하도록 알림
      for (const h of held ?? []) findings.push({ finding_id: newId("fnd"), step: "GraphUpsert", severity: "LOW", code: "CLAIM_REVIEW_HELD", message: h, evidence_ref: h,
        user_message: `이전 버전(${h})과 비교해 조문 절반 넘게 바뀐 것으로 나와, 관련 노하우 주장의 재검토 표시를 자동으로 하지 않았습니다.`, fix_hint: "개정 내용이 실제로 이렇게 많은지 확인하고, 본문 인식 문제라면 원본을 다시 올려 주세요." });
    }
    return { status: law.issues.length ? "REVIEW_REQUIRED" : "OK", findings };
  }
  // 노하우·매뉴얼: 존재하는 조문 인용만 게시, 없는 조문은 Finding
  const findings: Finding[] = [];
  const valid: Citation[] = [];
  for (const c of input.citations ?? []) {
    const [lawRev] = c.provision_id.split("/");
    const [lawId, rev] = lawRev!.split("@");
    const provs = await clauses.provisions(lawId!, rev!);
    if (provs?.some((p) => p.provision_id === c.provision_id)) valid.push(c);
    else findings.push({ finding_id: newId("fnd"), step: "GraphUpsert", severity: "MEDIUM", code: "CITATION_TARGET_MISSING", message: c.provision_id, evidence_ref: c.provision_id });
  }
  await graph.upsert(wikiGraph({ doc_id: input.doc_id, version: input.version, title: input.title, effective_from: input.effective_from, effective_to: input.effective_to, acl_groups: input.acl_groups }, valid));
  return { status: findings.length ? "REVIEW_REQUIRED" : "OK", findings };
}
