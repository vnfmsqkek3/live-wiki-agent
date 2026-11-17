// 단계 11 Promote: 승인 바인딩 소비(APPROVED→USED) 후 마스킹본을 published 버킷으로 + .metadata.json (interfaces.md 3·5·7.1장)
import { docDates, primaryDate } from "@hanaeum/legal-parser";
import { createHash } from "node:crypto";
import { MetadataSidecar, OPEN_END, figureLine, stepFailure } from "@hanaeum/schemas";
import type { DocumentMetadata, Figure, IndexGroup, StepInput, StepOutput } from "@hanaeum/schemas";
import type { DocumentRecord, ObjectStore, Records } from "./store.ts";

/** 게시 본문의 쪽 경계 (빈 줄로 취급되므로 파서·인용에는 영향 없음) */
export const PAGE_BREAK = "\f";
// ponytail: 쪽 정리본은 한 조각 2,000자(임베딩 입력 여유), 쪽당 계약 상한 6,000자 (interfaces 6.3)
const PAGE_MD_LINE = 2000;
const PAGE_MD_TOTAL = 6000;
export const sha256 = (b: Buffer | string) => "sha256:" + createHash("sha256").update(b).digest("hex");

/** 승인 레코드 해시와 원본 해시 비교. 승인 API가 S3 ChecksumSHA256(base64)을 저장해도, `sha256:{hex}`나 hex를 저장해도 같은 바이트면 일치 */
export function hashMatches(approvalHash: string, bytes: Buffer): boolean {
  const d = createHash("sha256").update(bytes).digest();
  const v = approvalHash.trim();
  return v === "sha256:" + d.toString("hex") || v.toLowerCase() === d.toString("hex") || v === d.toString("base64");
}

const INDEX_GROUP: Record<DocumentRecord["document_type"], IndexGroup> = {
  REGULATION: "legal-clauses", KNOWHOW: "wiki-knowledge", MANUAL: "official-manuals",
};
export const publishedPrefix = (d: Pick<DocumentRecord, "document_type" | "doc_id">) =>
  `${d.document_type === "REGULATION" ? "legal" : "knowledge"}/${d.doc_id}/`;

/** 본문 대표 일자 → YYYYMMDD (검색 기간 필터) */
const dateOf = (texts: string[]) => { const d = primaryDate(docDates(texts)); return d ? Number(d.date.replaceAll("-", "")) : undefined; };
const todayYmd = () => Number(new Date().toISOString().slice(0, 10).replaceAll("-", ""));

export function buildMetadata(doc: DocumentRecord, approval_id: string, content_hash: string, doc_date?: number, category_path?: string): DocumentMetadata {
  if (doc.authority_status === "REJECTED") throw stepFailure("RejectedDocument", "반려된 문서라 게시할 수 없습니다.", "반려 사유를 고쳐 새로 올려 주세요.");
  return {
    doc_id: doc.doc_id,
    document_type: doc.document_type,
    index_group: INDEX_GROUP[doc.document_type],
    authority_status: doc.authority_status,
    freshness: "CURRENT",
    lifecycle: "PUBLISHED",
    title: doc.title,
    ...(doc.law_id ? { law_id: doc.law_id, law_name: doc.law_name ?? doc.title } : {}),
    ...(doc.revision_id ? { revision_id: doc.revision_id } : {}),
    effective_from: doc.effective_from ?? (doc.revision_id ? Number(doc.revision_id.replaceAll("-", "")) : todayYmd()),
    effective_to: doc.effective_to ?? OPEN_END,
    acl_groups: doc.acl_groups,
    dept: doc.dept,
    ...(doc.business_path?.length ? { business_path: doc.business_path.slice(0, 3) } : {}),
    ...(doc.tags?.length ? { tags: doc.tags.slice(0, 8) } : {}),
    ...(doc_date ? { doc_date } : {}),
    ...(category_path ? { category_path } : {}),
    approval_id,
    content_hash,
  };
}

// approval_id: ASL이 넘기면 사용, 없으면 문서 버전으로 승인 레코드를 찾는다
export interface PromoteInput extends StepInput { approval_id?: string; published_bucket: string }

export async function promoteStep(input: PromoteInput, store: ObjectStore, records: Records): Promise<StepOutput> {
  const doc = await records.getDocument(input.doc_id);
  if (!doc) throw new Error(`Documents 레코드 없음: ${input.doc_id}`);
  if (doc.version !== input.version) throw stepFailure("VersionMismatch", `승인한 버전(v${input.version})과 현재 문서 버전(v${doc.version})이 달라 게시를 멈췄습니다.`, "최신 버전으로 다시 게시 요청해 주세요.");

  // 승인은 원본 객체 해시에 묶인다 (interfaces.md 7.1). 승인 이후 원본이 바뀌었으면 여기서 막힌다.
  const originals = await store.list(input.bucket, `${input.doc_id}/original.`);
  if (originals.length !== 1) throw new Error("original 객체가 1개가 아님");
  const original = await store.get(input.bucket, originals[0]!);
  const apr = input.approval_id ? await records.getApproval(input.approval_id) : await records.findApproval(input.doc_id, input.version, input.workflow_id);
  if (!apr || !hashMatches(apr.content_hash, original)) {
    throw stepFailure("ApprovalBindingError", apr ? "승인 이후 원본 파일이 바뀌었거나 이미 사용된 승인이라 게시하지 않았습니다." : "이 문서 버전의 승인 기록이 없어 게시하지 않았습니다.", "문서를 다시 게시 요청해 승인을 새로 받아 주세요.");
  }
  // 마스킹본만 게시 (원문·work/ 는 절대 published로 가지 않음). 페이지 수가 이번 추출 결과와 정확히 같아야 함 (이전 실행의 잔여 페이지 혼입 차단)
  const { page_count } = JSON.parse((await store.get(input.bucket, `${input.doc_id}/work/text_layer.json`)).toString()) as { page_count: number };
  const expected = Array.from({ length: page_count }, (_, i) => `${input.doc_id}/masked/segments/${String(i).padStart(4, "0")}.json`);
  const segKeys = (await store.list(input.bucket, `${input.doc_id}/masked/segments/`)).filter((k) => k.endsWith(".json"));
  if (segKeys.join() !== expected.join()) {
    throw segKeys.length < page_count
      ? stepFailure("MaskedSegmentsMismatch", `개인정보를 가린 본문이 ${segKeys.length}쪽뿐이라(전체 ${page_count}쪽) 게시를 멈췄습니다.`, "검사 단계가 끝나지 않았을 수 있습니다. 잠시 뒤 다시 게시 요청하거나 관리자에게 알려 주세요.")
      : stepFailure("MaskedSegmentsMismatch", `이전 처리의 쪽이 섞여 있어(본문 ${segKeys.length}쪽, 이번 문서 ${page_count}쪽) 게시를 멈췄습니다.`, "문서를 다시 올려 처음부터 처리해 주세요. 반복되면 관리자에게 알려 주세요.");
  }
  const texts: string[] = []; const figs: string[] = [];
  for (const [page, k] of segKeys.entries()) {
    const seg = JSON.parse((await store.get(input.bucket, k)).toString()) as { text: string; figures?: Figure[]; page_markdown?: string };
    texts.push(seg.text.replaceAll(PAGE_BREAK, "")); // 원문 속 폼피드는 쪽 경계와 헷갈리지 않게 제거
    for (const f of seg.figures ?? []) if (f.description?.trim()) figs.push(figureLine(page, f));
    // 그림 쪽 AI 정리본(interfaces 6.3): 검색에는 쓰되 인용 불가 그림 조각으로만 (⟦그림 pN⟧ 한 줄). 인용·주장 대조는 OCR text 기준 그대로
    // 한 줄 2,000자로 나눠 여러 그림 조각으로 (계약 상한 6,000자까지 버리지 않음, PR #38 리뷰)
    let md = seg.page_markdown?.replace(/\s+/gu, " ").trim().slice(0, PAGE_MD_TOTAL) ?? "";
    for (let part = 1; md; part++) {
      const cut = md.length <= PAGE_MD_LINE ? md : md.slice(0, PAGE_MD_LINE).replace(/\S*$/u, "").trimEnd() || md.slice(0, PAGE_MD_LINE);
      figs.push(`⟦그림 p${page}⟧ 쪽 정리(AI, 그림 기준)${part > 1 ? ` (이어서 ${part})` : ""}: ${cut}`);
      md = md.slice(cut.length).trim();
    }
  }
  // 쪽 경계는 폼피드(\f) 한 줄로 남긴다 → kb-chunker가 조각마다 쪽 번호(source_page)를 붙임 (검색 결과·가이드 근거의 쪽 썸네일, 사용자 요청 11/17)
  const content = [texts.join(`\n${PAGE_BREAK}\n`), ...figs].join("\n");
  if (!content.trim()) throw stepFailure("EmptyContent", "게시할 본문이 비어 있습니다(모든 쪽에서 글자를 찾지 못함).", "글자가 들어 있는 원본을 다시 올려 주세요.");

  const contentHash = sha256(content);
  // 분류 경로는 탐색용 부가 정보라 조회 실패(스키마 배포 전 등)로 게시를 막지 않는다. 검색은 현재 분류로 다시 거른다
  // 스키마 배포 전(테이블·열 없음)만 생략하고, 그 밖의 오류(스로틀·SQL 버그)는 던져 재시도에 맡긴다 (승인 소비 전이라 안전, PR #32 리뷰)
  const path = await records.categoryPath?.(input.doc_id).catch((e: unknown) => {
    const msg = String((e as Error).message ?? "");
    if (!/42P01|42703|does not exist/u.test(msg)) throw e;
    console.warn(JSON.stringify({ msg: "분류 테이블 없음 → 경로 생략", error: msg.slice(0, 200) }));
    return undefined;
  });
  // 경로가 너무 길면(AI가 만든 3단계 이름) 생략. 게시를 막지 않는다
  const category = path && path.length <= 200 ? path : undefined;
  if (path && !category) console.warn(JSON.stringify({ msg: "분류 경로 200자 초과 → 생략", length: path.length }));
  const parsed = MetadataSidecar.safeParse({ metadataAttributes: buildMetadata(doc, apr.approval_id, contentHash, dateOf(texts), category) });
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.message).join(", ");
    throw doc.document_type === "REGULATION" && /law_id|revision_id/u.test(fields)
      ? stepFailure("RegulationNotInRegistry", "공식 규정으로 분류됐지만 공식 원본 목록(Registry)에서 이 규정을 찾지 못해 게시할 수 없습니다.", "공식 규정 원본 PDF가 맞는지 확인하거나, 업무 노하우라면 분류를 '노하우'로 바꿔 다시 게시 요청해 주세요.")
      : stepFailure("InvalidMetadata", `문서 정보가 부족해 게시할 수 없습니다(${fields.slice(0, 120)}).`, "제목·부서·공개 범위를 확인한 뒤 다시 게시 요청해 주세요.");
  }
  const meta = parsed.data;
  // 게시 가능 여부(세그먼트·본문·메타데이터)를 다 확인한 뒤에 승인을 소비한다 (입력 결함으로 실패해도 승인이 소모되지 않게).
  // 조건부 전환은 레코드에 저장된 해시 값 그대로로 (형식 차이와 무관하게 위에서 바이트 일치를 확인함)
  await records.consumeApproval({ approval_id: apr.approval_id, doc_id: input.doc_id, version: input.version, content_hash: apr.content_hash, workflow_id: input.workflow_id });
  const key = `${publishedPrefix(doc)}content.txt`;
  await store.put(input.published_bucket, key, content, "text/plain; charset=utf-8");
  await store.put(input.published_bucket, `${key}.metadata.json`, JSON.stringify(meta));
  // ASL은 status만 넘기므로 게시본 해시는 Documents.published_content_hash에 직접 기록 (검색 재검증 기준)
  await records.setPublishedHash(input.doc_id, contentHash);
  return { status: "OK", output_key: key, content_hash: contentHash };
}
