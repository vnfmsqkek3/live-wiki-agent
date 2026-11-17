import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DocumentMetadata } from "@hanaeum/schemas";
import { chunkDocument, transform, MAX_CHUNK_CHARS } from "./index.ts";
import type { Io } from "./index.ts";

const FIX = new URL("../../../tests/fixtures/", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, FIX), "utf8");
const meta = (o: Partial<DocumentMetadata> = {}): DocumentMetadata => ({
  doc_id: "F-001", title: "하나은행 기업여신 심사규정", law_name: "하나은행 기업여신 심사규정", document_type: "REGULATION", index_group: "legal-clauses",
  authority_status: "VERIFIED", freshness: "CURRENT", lifecycle: "PUBLISHED", law_id: "SYN-LOAN-001", revision_id: "2026-11-01",
  effective_from: 20261101, effective_to: 99991231, acl_groups: ["ALL"], dept: "여신", approval_id: "apr_1", content_hash: "sha256:" + "0".repeat(64), ...o,
});

test("법령: 항 단위 청크, 항 없는 조는 조 전체, 문맥 헤더에 법령명·시행일·장·조 제목", () => {
  const chunks = chunkDocument(read("documents/F-001.txt"), meta());
  const ids = chunks.map((c) => c.metadata.provision_id.split("/").slice(1).join("/"));
  assert.ok(ids.includes("ARTICLE:12/PARAGRAPH:1"));
  assert.ok(ids.includes("ARTICLE:11")); // 항 없는 조
  assert.ok(!ids.includes("ARTICLE:12")); // 항이 있는 조는 Parent로만 (청크 아님)
  assert.ok(ids.includes("ARTICLE:10/PARAGRAPH:1"));
  assert.ok(!ids.some((i) => i.includes("ITEM")), "짧은 항의 호는 항 청크에 포함");
  const c = chunks.find((x) => x.metadata.provision_id.endsWith("ARTICLE:12/PARAGRAPH:1"))!;
  assert.equal(c.augmented_search_text.split("\n")[0], "[하나은행 기업여신 심사규정 · 시행 2026-11-01 · 제2장 심사 절차 · 제12조(승인 기준) · 제12조제1항]");
  assert.equal(c.metadata.parent_id, "SYN-LOAN-001@2026-11-01/ARTICLE:12");
  assert.equal(c.metadata.provision_path, "제12조제1항");
});

test("임베딩 입력(contentBody)에 실제 본문이 들어감 — 헤더만 임베딩되는 사고 방지", () => {
  for (const c of chunkDocument(read("documents/F-001.txt"), meta())) {
    const body = c.augmented_search_text.split("\n").slice(1).join("\n");
    if (c.metadata.provision_status === "DELETED") continue;
    assert.ok(body.replace(/\s/gu, "").length >= 10, `${c.metadata.provision_id} 본문 없음`);
    assert.ok(c.metadata.original_text.length > 0);
  }
  const c = chunkDocument(read("documents/F-001.txt"), meta()).find((x) => x.metadata.provision_id.endsWith("ARTICLE:12/PARAGRAPH:1"))!;
  assert.match(c.augmented_search_text, /5억원 이상인 경우 본부 여신심사위원회/u);
  assert.match(c.metadata.original_text, /^① 여신 금액이 5억원/u);
});

test("호 포함 항: 원문에 하위 호가 함께 들어감, 삭제 조항은 DELETED 상태 청크", () => {
  const chunks = chunkDocument(read("legal/source/L-001.txt"), meta({ doc_id: "L-001", law_id: "SYN-VLOAN-001", law_name: "가상여신거래법", title: "가상여신거래법" }));
  const p2 = chunks.find((c) => c.metadata.provision_id.endsWith("ARTICLE:12/PARAGRAPH:2"))!;
  assert.match(p2.metadata.original_text, /1의2\. 국채담보대출/u);
  const del = chunks.find((c) => c.metadata.provision_id.endsWith("ARTICLE:12/PARAGRAPH:4"))!;
  assert.equal(del.metadata.provision_status, "DELETED");
  assert.ok(chunks.some((c) => c.metadata.provision_id.includes("SUPPLEMENTARY:1/ARTICLE:2")));
  assert.ok(chunks.some((c) => c.metadata.provision_id.endsWith("ANNEX:1")));
});

test("긴 항은 호 단위로 분할", () => {
  const long = "가".repeat(MAX_CHUNK_CHARS);
  const text = `제1조(목적) ① 다음 각 호를 따른다.\n1. ${long}\n2. 둘째 호 내용입니다.\n② 둘째 항.`;
  const chunks = chunkDocument(text, meta({ law_id: "SYN-T-1", revision_id: "2026-01-01" }));
  const ids = chunks.map((c) => c.metadata.provision_id.split("/").slice(1).join("/"));
  assert.deepEqual(ids, ["ARTICLE:1/PARAGRAPH:1", "ARTICLE:1/PARAGRAPH:1/ITEM:1", "ARTICLE:1/PARAGRAPH:1/ITEM:2", "ARTICLE:1/PARAGRAPH:2"]);
  assert.match(chunks[2]!.augmented_search_text, /^\[.*제1조제1항제2호\]\n2\. 둘째 호/u);
});

test("노하우: 섹션 단위, front matter 제거", () => {
  const chunks = chunkDocument(read("documents/K-001.md"), meta({ doc_id: "K-001", title: "부동산 담보평가 실무 노하우", document_type: "KNOWHOW", index_group: "wiki-knowledge", law_id: undefined, revision_id: undefined, law_name: undefined }));
  assert.deepEqual(chunks.map((c) => c.metadata.provision_path), ["부동산 담보평가 실무 노하우", "적용 조건", "절차", "실패 사례"]);
  assert.ok(!chunks.some((c) => c.augmented_search_text.includes("cites:")));
  assert.match(chunks[2]!.augmented_search_text, /^\[부동산 담보평가 실무 노하우 · 노하우 · 절차\]/u);
});

test("Lambda transform: 배치 읽기 → 청크 배치 쓰기, 메타데이터 누락·미게시 문서는 실패", async () => {
  const files = new Map<string, string>([["in/F-001.json", JSON.stringify({ fileContents: [{ contentBody: read("documents/F-001.txt"), contentType: "string" }] })]]);
  const io: Io = { read: async (_b, k) => files.get(k)!, write: async (_b, k, v) => { files.set(k, v); } };
  const loc = { type: "S3", s3_location: { uri: "s3://p/legal/F-001/content.txt" } };
  const out = await transform({ bucketName: "inter", inputFiles: [{ originalFileLocation: loc, fileMetadata: meta(), contentBatches: [{ key: "in/F-001.json" }] }] }, io);
  const key = out.outputFiles[0]!.contentBatches[0]!.key;
  const batch = JSON.parse(files.get(key)!);
  assert.ok(batch.fileContents.length > 5);
  assert.equal(batch.fileContents[0].contentType, "TEXT");
  assert.ok(batch.fileContents[0].contentMetadata.provision_id);
  // 숫자 필드가 문자열로 와도 처리
  const strMeta = { ...meta(), effective_from: "20261101", effective_to: "99991231" } as unknown as Record<string, unknown>;
  assert.equal((await transform({ bucketName: "inter", inputFiles: [{ originalFileLocation: loc, fileMetadata: strMeta, contentBatches: [{ key: "in/F-001.json" }] }] }, io)).outputFiles.length, 1);
  // 계약 위반·미게시 파일은 색인 제외(원문 1청크로 넘기지 않음), 같은 호출의 정상 파일은 색인
  const mixed = await transform({ bucketName: "inter", inputFiles: [
    { originalFileLocation: loc, fileMetadata: { doc_id: "x" }, contentBatches: [{ key: "in/F-001.json" }] },
    { originalFileLocation: loc, fileMetadata: meta({ lifecycle: "IN_REVIEW" }), contentBatches: [{ key: "in/F-001.json" }] },
    { originalFileLocation: loc, fileMetadata: meta(), contentBatches: [{ key: "in/F-001.json" }] },
  ] }, io);
  assert.equal(mixed.outputFiles.length, 1);
  assert.deepEqual(mixed.outputFiles[0]!.fileMetadata, meta());
});

test("그림 묘사 줄(⟦그림 pN⟧)은 본문 파싱에서 빠지고 별도 청크(has_figure, 인용 원문 없음)로", async () => {
  const { figureLine } = await import("@hanaeum/schemas");
  const law = readFileSync(new URL("../../../tests/fixtures/documents/F-001.txt", import.meta.url), "utf8");
  const fig = figureLine(1, { kind: "표", description: "여신 금액별 승인권자 표", overlay_text: "5억원 이상 본부", intent: "승인 기준 요약" });
  const base = chunkDocument(law, meta());
  const withFig = chunkDocument(`${law}\n${fig}`, meta());
  assert.equal(withFig.length, base.length + 1, "본문 청크는 그대로, 그림 청크 1개 추가");
  assert.deepEqual(withFig.slice(0, -1).map((c) => c.metadata.original_text), base.map((c) => c.metadata.original_text));
  const f = withFig.at(-1)!;
  assert.equal(f.metadata.has_figure, true);
  assert.equal(f.metadata.original_text, "", "그림 묘사는 인용 원문이 아님");
  assert.equal(f.metadata.source_page, 1);
  assert.match(f.augmented_search_text, /그림 \(2쪽\)[\s\S]*승인권자 표 \/ 표기: 5억원 이상 본부 \/ 의도: 승인 기준 요약/u);
});

test("쪽 번호: Promote의 쪽 경계(\\f)로 조각마다 source_page(0부터), 경계 문자는 본문·인용에 남지 않음 (사용자 요청 11/17 쪽 썸네일)", () => {
  const reg = "제1조(목적) 이 규정은 여신 심사를 정한다.\n제2조(적용) 이 규정은 모든 영업점에 적용한다.\n\f\n제3조(승인) 본부 승인을 받아야 한다.\n⟦그림 p1⟧ 표: 승인 한도표";
  const cs = chunkDocument(reg, meta({ document_type: "REGULATION", law_id: "SYN-X", law_name: "x", revision_id: "2026-11-01" }));
  const byPath = (p: string) => cs.find((c) => c.metadata.provision_path === p)!;
  assert.equal(byPath("제1조").metadata.source_page, 0);
  assert.equal(byPath("제3조").metadata.source_page, 1);
  assert.equal(cs.find((c) => c.metadata.has_figure)!.metadata.source_page, 1);
  assert.ok(cs.every((c) => !c.metadata.original_text.includes("\f") && !c.augmented_search_text.includes("\f")));
  // 노하우: 절이 시작한 쪽
  const kh = chunkDocument("## 준비\n서류를 확인한다.\n\f\n## 실행\n현장 실사를 한다.", meta({ document_type: "KNOWHOW", index_group: "wiki-knowledge" }));
  assert.deepEqual(kh.map((c) => c.metadata.source_page), [0, 1]);
});

test("쪽 번호는 위치로: 쪽마다 반복되는 머리말과 글자가 같아도 앞쪽에 붙지 않음 (PR #37 리뷰)", () => {
  const reg = "하나은행 기업여신 심사규정\n제1조(목적) 이 규정은 여신 심사를 정한다.\n\f\n하나은행 기업여신 심사규정\n제2조(목적) 이 규정은 여신 심사를 정한다.";
  const cs = chunkDocument(reg, meta({ document_type: "REGULATION", law_id: "SYN-X", law_name: "x", revision_id: "2026-11-01" }));
  assert.equal(cs.find((c) => c.metadata.provision_path === "제2조")!.metadata.source_page, 1);
  const kh = chunkDocument("---\ntitle: t\n---\n## 준비\n같은 문장.\n\f\n## 실행\n같은 문장.", meta({ document_type: "KNOWHOW", index_group: "wiki-knowledge" }));
  assert.deepEqual(kh.map((c) => c.metadata.source_page), [0, 1]);
});

test("노하우·매뉴얼 조각: 제목 없는 OCR 본문도 쪽·길이로 나누고 표는 자르지 않음 (과천 매뉴얼 11/18)", () => {
  const kh = (t: string) => chunkDocument(t, meta({ document_type: "MANUAL", index_group: "wiki-knowledge" }));
  // 쪽마다 조각, 쪽 번호
  const cs = kh("표지 MEGAZONE\n\f\n01 층별 복합기 정보\n| 위치 | 모델 |\n| --- | --- |\n| ① | N620 |\n| ⑤ | Brother |\n\f\n02 드라이버 설치");
  assert.deepEqual(cs.map((c) => c.metadata.source_page), [0, 1, 2]);
  assert.match(cs[1]!.metadata.original_text, /\| ⑤ \| Brother \|/u);
  // 길이 초과: 줄 단위로 나눔, 표는 한 덩어리
  const long = Array.from({ length: 30 }, (_, i) => `${i + 1}. ${"설명 문장입니다 ".repeat(10)}`).join("\n");
  const table = ["| 구분 | 값 |", "| --- | --- |", ...Array.from({ length: 5 }, (_, i) => `| 행${i} | 값${i} |`)].join("\n");
  const cs2 = kh(`${long}\n${table}`);
  assert.ok(cs2.length > 1 && cs2.every((c) => c.metadata.original_text.length <= MAX_CHUNK_CHARS));
  assert.equal(cs2.filter((c) => c.metadata.original_text.includes("| 행0 |")).length, 1);
  assert.ok(cs2.find((c) => c.metadata.original_text.includes("| 행0 |"))!.metadata.original_text.includes("| 행4 |"));
  // 상한을 넘는 큰 표는 머리행을 반복해 행 단위로
  const big = ["| 구분 | 값 |", "| --- | --- |", ...Array.from({ length: 200 }, (_, i) => `| 행${i} | ${"값".repeat(20)} |`)].join("\n");
  const cs3 = kh(big);
  assert.ok(cs3.length > 1 && cs3.every((c) => c.metadata.original_text.startsWith("| 구분 | 값 |\n| --- | --- |")));
});

test("조각 상한 (PR #41 리뷰): 아주 긴 한 줄은 낱말 경계로 나눔, 구분행 없는 큰 표는 첫 줄만 머리행", () => {
  const kh = (t: string) => chunkDocument(t, meta({ document_type: "MANUAL", index_group: "wiki-knowledge" }));
  const cs = kh("가나다라 ".repeat(1000));
  assert.ok(cs.length > 1 && cs.every((c) => c.metadata.original_text.length <= MAX_CHUNK_CHARS));
  const big = ["| 머리 | 값 |", ...Array.from({ length: 200 }, (_, i) => `| 행${i} | ${"값".repeat(20)} |`)].join("\n");
  const cs2 = kh(big);
  assert.ok(cs2.length > 1 && cs2.every((c) => c.metadata.original_text.startsWith("| 머리 | 값 |\n| 행")));
  assert.equal(cs2.filter((c) => c.metadata.original_text.includes("| 행0 |")).length, 1);
});

test("쪽 맥락은 본문 조각 검색 머리·page_context로만, 쪽 정리본은 매뉴얼·노하우에서 그림 기준 근거(인용 가능), 규정은 그대로", () => {
  const text = "4층 복합기 표\n| 위치 | 모델 |\n⟦그림 p0⟧ 쪽 맥락(AI, 그림 기준): 01 층별 복합기 정보 › 그림 1: 4층\n⟦그림 p0⟧ 쪽 정리(AI, 그림 기준): 1. **다운로드** 접속\n⟦그림 p0⟧ 그림 1 속 글자: 4층 10 7";
  const cs = chunkDocument(text, meta({ document_type: "MANUAL", index_group: "wiki-knowledge" }));
  const body = cs.find((c) => !c.metadata.has_figure)!;
  assert.equal(body.metadata.page_context, "01 층별 복합기 정보 › 그림 1: 4층");
  assert.match(body.augmented_search_text.split("\n")[1]!, /^\[쪽 맥락 · 그림 기준\(AI\)\] 01 층별/u);
  assert.ok(!body.metadata.original_text.includes("쪽 맥락"));
  assert.ok(!cs.some((c) => c.augmented_search_text.includes("⟦")));
  const summary = cs.find((c) => c.metadata.evidence_kind === "FIGURE")!;
  assert.equal(summary.metadata.original_text, "1. **다운로드** 접속");
  const inner = cs.find((c) => c.metadata.has_figure && !c.metadata.evidence_kind)!;
  assert.equal(inner.metadata.original_text, "");
  const reg = chunkDocument("제1조(목적) 이 규정은 정한다.\n⟦그림 p0⟧ 쪽 정리(AI, 그림 기준): 요약", meta({ document_type: "REGULATION", law_id: "SYN-X", law_name: "x", revision_id: "2026-11-01" }));
  assert.ok(reg.every((c) => !c.metadata.evidence_kind));
});

test("장(章): 쪽 첫 줄의 장 번호로 나누고 번호 없는 쪽은 앞 장을 이음, 쪽 범위 (과천 매뉴얼 11/18)", () => {
  const pages = ["표지 MEGAZONE", "목차", "01.층별 복합기 정보", "01 층별 복합기 정보\n| ① | N620 |", "02.삼성 복합기 드라이버", "02 삼성 복합기 드라이버 설치 방법\n1. 다운로드", "설치 계속 화면", "⑤ 근무지 이동시 복합기 아이피 변경 방법"];
  const cs = chunkDocument(pages.join("\n\f\n") + "\n⟦그림 p5⟧ 그림 1 속 글자: 다운로드", meta({ document_type: "MANUAL", index_group: "wiki-knowledge" }));
  const at = (p: number) => cs.find((c) => !c.metadata.has_figure && c.metadata.source_page === p)!.metadata;
  assert.equal(at(0).section, undefined);
  assert.deepEqual([at(3).section, at(3).section_pages], ["01 층별 복합기 정보", "3-4"]);
  assert.deepEqual([at(6).section, at(6).section_pages], ["02 삼성 복합기 드라이버", "5-7"]); // 번호 없는 7쪽은 2장을 이음
  assert.equal(at(7).section, "05 근무지 이동시 복합기 아이피 변경 방법");
  assert.equal(cs.find((c) => c.metadata.has_figure)!.metadata.section, "02 삼성 복합기 드라이버"); // 그림 조각도 같은 장
  // 규정은 장 메타데이터 없음 (조문 구조가 따로 있음)
  assert.ok(chunkDocument("제1조(목적) 이 규정은 정한다.", meta()).every((c) => !c.metadata.section));
});
