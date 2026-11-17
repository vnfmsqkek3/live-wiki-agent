import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MetadataSidecar, StepInput as StepInputSchema } from "@hanaeum/schemas";
import type { StepInput } from "@hanaeum/schemas";
import { MemoryObjectStore, MemoryRecords, textLayerStep, segmentStep, promoteStep, kbIngestStep, extractTextLayer, sha256 } from "./index.ts";
import type { IngestionApi, OcrResult } from "./index.ts";

const FIX = new URL("../../../tests/fixtures/", import.meta.url);
const Q = "hanaeum-mvp-s3-quarantine-test";
const P = "hanaeum-mvp-s3-published-test";
const DOC = "doc_01JD3ABCDEFGHJKMNPQRSTVWXY";
const input: StepInput = { workflow_id: "wf_01JD3ABCDEFGHJKMNPQRSTVWXY", doc_id: DOC, version: 1, bucket: Q, prefix: `${DOC}/`, actor: { sub: "u-author", groups: ["AUTHOR"] } };

/** 최소 텍스트 PDF (ASCII, Helvetica). 2페이지: 1쪽 텍스트 충분, 2쪽 빈 페이지(→ OCR 대상) */
function tinyPdf(pages: string[]): Buffer {
  const objs: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids: string[] = [];
  pages.forEach((t, i) => {
    const pageNo = 3 + i * 2;
    kids.push(`${pageNo} 0 R`);
    const stream = t ? `BT /F1 10 Tf 20 100 Td (${t}) Tj ET` : "";
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${pageNo + 1} 0 R >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objs[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

test("3a: 변환 PDF(document.pdf)가 있으면 디지털 글자를 추출하지 않고 모든 쪽 OCR (사용자 결정 11/17), 없으면 지금 방식, 미지원 형식은 실패", async () => {
  const two = tinyPdf(["SYNTHETIC Hana Bank loan regulation article 12 approval threshold text", ""]);
  const layer = await extractTextLayer(two, "pdf", DOC, two);
  assert.equal(layer.page_count, 2);
  assert.ok(layer.pages.every((p) => p.needs_ocr && p.text === ""));
  // 변환 단계 배포 전(document.pdf 없음): 쪽별 글자 수로 판정 (배포 순서가 어긋나도 멈추지 않게)
  assert.deepEqual((await extractTextLayer(two, "pdf", DOC)).pages.map((p) => p.needs_ocr), [false, true]);
  // 변환본이 깨졌으면 올린 사람 탓(BLOCKED)이 아니라 시스템 오류
  await assert.rejects(extractTextLayer(two, "pdf", DOC, Buffer.from("깨진 변환본")), { name: "ConvertedPdfInvalid" });
  // DOCX·이미지: ConvertToPdf 결과(document.pdf)의 쪽 수, 전부 OCR
  assert.deepEqual((await extractTextLayer(Buffer.from("zip 아님"), "docx", DOC, two)).pages.map((p) => p.needs_ocr), [true, true]);
  assert.equal((await extractTextLayer(Buffer.from("png"), "png", DOC, two)).page_count, 2);
  // TXT는 글자 그대로
  const t = await extractTextLayer(Buffer.from("SYNTHETIC 짧은 메모"), "txt", DOC);
  assert.equal(t.pages[0]!.needs_ocr, false);
  assert.equal(t.pages[0]!.text, "SYNTHETIC 짧은 메모");
  await assert.rejects(extractTextLayer(Buffer.from("x"), "docx", DOC)); // 깨진 DOCX(ZIP 아님)는 실패
  await assert.rejects(extractTextLayer(Buffer.from("x"), "xlsx", DOC), /지원하지 않는 형식/u);
});

test("5: OCR 필요한데 결과 없으면 실패, 저신뢰면 REVIEW_REQUIRED", async () => {
  const s = new MemoryObjectStore();
  await s.put(Q, `${DOC}/original.png`, readFileSync(new URL("documents/A-002.png", FIX)));
  await textLayerStep(input, s);
  await assert.rejects(segmentStep(input, s), /NoSuchKey/u);
  const ocr: OcrResult = { doc_id: DOC, model: "paddleocr", model_version: "test", page_count: 1, pages: [{ page_index: 0, width: 2000, height: 2828, source: "ocr", blocks: [
    { block_id: "p0-b1", label: "paragraph", text: "제12조(승인 기준)", confidence: 0.97, bbox: [40, 140, 600, 190], reading_order: 1, table_id: null },
    { block_id: "p0-b0", label: "title", text: "SYNTHETIC", confidence: 0.6, bbox: [40, 40, 500, 90], reading_order: 0, table_id: null },
  ] }] };
  await s.put(Q, `${DOC}/work/ocr/result.json`, JSON.stringify(ocr));
  const out = await segmentStep(input, s);
  assert.equal(out.status, "REVIEW_REQUIRED");
  assert.equal(out.findings![0]!.code, "LOW_OCR_CONFIDENCE");
  const seg = JSON.parse((await s.get(Q, `${DOC}/work/segments/0000.json`)).toString());
  assert.equal(seg.text, "SYNTHETIC\n제12조(승인 기준)"); // 위→아래 줄 순서
});

test("5: 글자 없는 사진(강아지 사진 실측 11/17)은 예외로 멈추지 않고 이유와 함께 BLOCKED", async () => {
  const s = new MemoryObjectStore();
  await s.put(Q, `${DOC}/original.png`, readFileSync(new URL("documents/A-002.png", FIX)));
  await textLayerStep(input, s);
  // 실제 PaddleOCR 출력: 그림 전체를 빈 문단 1개로 돌려줌
  await s.put(Q, `${DOC}/work/ocr/result.json`, JSON.stringify({ doc_id: DOC, model: "paddleocr", model_version: "3.7.0", page_count: 1, pages: [{ page_index: 0, width: 1024, height: 1024, source: "ocr",
    blocks: [{ block_id: "p0-b0", label: "paragraph", text: "", confidence: 0, bbox: [80, 2, 929, 967], reading_order: 0, table_id: null }] }] }));
  const out = await segmentStep(input, s);
  assert.equal(out.status, "BLOCKED");
  const f = out.findings![0]!;
  assert.equal(f.code, "NO_TEXT");
  assert.match(f.user_message!, /글자를 찾지 못했습니다/u);
  assert.ok(f.fix_hint);
});

test("3a→5→11: F-001 정상 흐름, 승인 1회만 사용, 메타데이터 계약 준수", async () => {
  const s = new MemoryObjectStore();
  const r = new MemoryRecords();
  const original = readFileSync(new URL("documents/F-001.txt", FIX));
  await s.put(Q, `${DOC}/original.txt`, original);
  assert.equal((await textLayerStep(input, s)).status, "OK");
  assert.equal((await segmentStep(input, s)).status, "OK");
  // 단계 6(PII 마스킹, dhxorb96) mock: segments를 masked로 그대로 복사
  for (const k of await s.list(Q, `${DOC}/work/segments/`)) await s.put(Q, k.replace("/work/", "/masked/"), await s.get(Q, k));

  r.documents.set(DOC, { doc_id: DOC, version: 1, title: "기업여신 심사규정 v1", document_type: "REGULATION", authority_status: "VERIFIED", dept: "여신", acl_groups: ["ALL"], law_id: "SYN-LOAN-001", revision_id: "2026-11-01" });
  r.approvals.set("apr_1", { approval_id: "apr_1", doc_id: DOC, version: 1, content_hash: sha256(original), status: "APPROVED" });
  r.approvals.set("apr_bad", { approval_id: "apr_bad", doc_id: DOC, version: 1, content_hash: sha256("다른 내용"), status: "APPROVED" });

  const pin = { ...input, approval_id: "apr_bad", published_bucket: P };
  await assert.rejects(promoteStep(pin, s, r), { name: "ApprovalBindingError" }); // 해시 불일치
  assert.equal((await s.list(P, "")).length, 0, "실패 시 published에 아무것도 없음");

  // 업무 분류 경로(interfaces 10.1)는 사이드카에 들어감
  (r as unknown as { categoryPath: (d: string) => Promise<string | undefined> }).categoryPath = async () => "여신/기업여신";
  const out = await promoteStep({ ...pin, approval_id: "apr_1" }, s, r);
  assert.equal(out.output_key, `legal/${DOC}/content.txt`);
  assert.equal(JSON.parse((await s.get(P, `legal/${DOC}/content.txt.metadata.json`)).toString()).metadataAttributes.category_path, "여신/기업여신");
  // 분류 조회가 실패해도(스키마 배포 전 등) 게시는 계속, 경로만 생략
  (r as unknown as { categoryPath: (d: string) => Promise<string | undefined> }).categoryPath = async () => { throw Object.assign(new Error('ERROR: relation "categories" does not exist; SQLState: 42P01'), { name: "DatabaseErrorException" }); };
  assert.equal(r.approvals.get("apr_1")!.status, "USED");
  // 같은 워크플로 재시도는 허용(멱등), 다른 워크플로의 재사용은 차단
  assert.equal((await promoteStep({ ...pin, approval_id: "apr_1" }, s, r)).status, "OK");
  assert.equal(JSON.parse((await s.get(P, `legal/${DOC}/content.txt.metadata.json`)).toString()).metadataAttributes.category_path, undefined);
  // 그 밖의 조회 오류는 던져 재시도 (스로틀·SQL 버그를 묻지 않음)
  (r as unknown as { categoryPath: (d: string) => Promise<string | undefined> }).categoryPath = async () => { throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }); };
  await assert.rejects(promoteStep({ ...pin, approval_id: "apr_1" }, s, r), { name: "ThrottlingException" });
  (r as unknown as { categoryPath?: unknown }).categoryPath = undefined;
  await assert.rejects(promoteStep({ ...pin, workflow_id: "wf_other", approval_id: "apr_1" }, s, r), /재사용/u);
  assert.match(out.content_hash!, /^sha256:/u);
  // 이전 실행의 잔여 마스킹 페이지가 섞이면 실패
  await s.put(Q, `${DOC}/masked/segments/0007.json`, JSON.stringify({ text: "옛 페이지" }));
  r.approvals.set("apr_2", { approval_id: "apr_2", doc_id: DOC, version: 1, content_hash: sha256(original), status: "APPROVED" });
  await assert.rejects(promoteStep({ ...pin, approval_id: "apr_2" }, s, r), /이전 처리의 쪽이 섞여/u);
  assert.equal(r.approvals.get("apr_2")!.status, "APPROVED", "게시 실패 시 승인을 소비하지 않음");
  // 규정인데 law_id 없음(Registry 대조 전) → 메타데이터 검증 실패, 승인은 그대로
  s.objects.delete(`${Q}/${DOC}/masked/segments/0007.json`);
  const full = r.documents.get(DOC)!;
  r.documents.set(DOC, { ...full, law_id: undefined, revision_id: undefined });
  await assert.rejects(promoteStep({ ...pin, approval_id: "apr_2" }, s, r), { name: "RegulationNotInRegistry" });
  assert.equal(r.approvals.get("apr_2")!.status, "APPROVED");
  r.documents.set(DOC, full);

  const meta = MetadataSidecar.parse(JSON.parse((await s.get(P, `legal/${DOC}/content.txt.metadata.json`)).toString())).metadataAttributes;
  assert.equal(meta.index_group, "legal-clauses");
  assert.equal(meta.effective_from, 20261101);
  assert.equal(meta.doc_date, 20261101, "본문 머리말 시행일 → 검색 기간 필터용 doc_date");
  assert.equal(meta.content_hash, sha256(await s.get(P, `legal/${DOC}/content.txt`)));
  assert.ok(!(await s.list(P, "")).some((k) => k.includes("original") || k.includes("work")), "원문·중간 산출물 게시 금지");
});

test("12: 폴링 계약 — 첫 호출 시작·PENDING, 재호출 상태 조회, COMPLETE + 실패 0건만 OK", async () => {
  const env = { KB_ID: "kb", KB_DS_LEGAL_ID: "ds-legal", KB_DS_KNOWLEDGE_ID: "ds-know", BUCKET_ARTIFACT: "art" };
  const s = new MemoryObjectStore();
  const r = new MemoryRecords();
  r.documents.set(DOC, { doc_id: DOC, version: 1, title: "K", document_type: "KNOWHOW", authority_status: "VERIFIED", dept: "여신", acl_groups: ["ALL"] });
  let starts = 0;
  let state = { status: "IN_PROGRESS", failed: 0, failureReasons: [] as string[] };
  const api: IngestionApi = { start: async (_k, ds) => { starts++; assert.equal(ds, "ds-know"); return "job-1"; }, get: async () => state };
  assert.equal((await kbIngestStep(input, api, r, s, env)).status, "PENDING");
  assert.equal((await kbIngestStep(input, api, r, s, env)).status, "PENDING");
  assert.equal(starts, 1, "재호출 시 Job을 다시 시작하지 않음 (멱등)");
  state = { status: "COMPLETE", failed: 1, failureReasons: [] };
  await assert.rejects(kbIngestStep(input, api, r, s, env), /1건이 실패/u);
  state = { status: "COMPLETE", failed: 0, failureReasons: [] };
  assert.equal((await kbIngestStep(input, api, r, s, env)).status, "OK");
  state = { status: "FAILED", failed: 0, failureReasons: ["Access denied to OpenSearch index"] };
  await assert.rejects(kbIngestStep(input, api, r, s, env), (e: Error & { user_message?: string; details?: string }) =>
    e.user_message === "검색 색인에 실패했습니다." && !/[A-Za-z]{4,}/u.test(e.message) && /FAILED: Access denied/u.test(e.details!)); // 화면 문장에 AWS 영문 금지, 원문은 details
});

test("11: approval_id 없이 문서 버전으로 승인 조회, S3 ChecksumSHA256(base64) 형식 해시도 일치 판정", async () => {
  const { createHash } = await import("node:crypto");
  const s = new MemoryObjectStore();
  const r = new MemoryRecords();
  const original = Buffer.from("SYNTHETIC 노하우 본문");
  await s.put(Q, `${DOC}/original.md`, original);
  await s.put(Q, `${DOC}/work/text_layer.json`, JSON.stringify({ page_count: 1 }));
  await s.put(Q, `${DOC}/masked/segments/0000.json`, JSON.stringify({ text: "SYNTHETIC 노하우 본문" }));
  r.documents.set(DOC, { doc_id: DOC, version: 1, title: "K", document_type: "KNOWHOW", authority_status: "VERIFIED", dept: "여신", acl_groups: ["ALL"] });
  r.approvals.set("apr_9", { approval_id: "apr_9", doc_id: DOC, version: 1, content_hash: createHash("sha256").update(original).digest("base64"), status: "APPROVED" });
  const out = await promoteStep({ ...input, published_bucket: P }, s, r);
  assert.equal(out.status, "OK");
  assert.equal(r.approvals.get("apr_9")!.status, "USED");
  assert.equal(r.documents.get(DOC)!.published_content_hash, out.content_hash);
  const first = r.documents.get(DOC)!.published_at;
  assert.match(first ?? "", /^\d{4}-\d{2}-\d{2}T/u, "게시 시각 기록");
  await promoteStep({ ...input, published_bucket: P }, s, r);
  assert.equal(r.documents.get(DOC)!.published_at, first, "같은 workflow 재시도는 게시 시각을 바꾸지 않음");
});

test("승인 API 형식의 Documents 항목 정규화: classification 유형·문자열 시행일, 유형 없으면 게시 거부", async () => {
  const { normalizeDocument } = await import("./store.ts");
  const base = { doc_id: DOC, version: 1, title: "t", dept: "d", acl_groups: ["ALL"], authority_status: "VERIFIED" };
  const d = normalizeDocument({ ...base, classification: { document_type: "REGULATION", business_path: ["여신", "심사"], tags: ["승인", " "] }, effective_from: "2026-11-01", effective_to: "9999-12-31" });
  assert.deepEqual([d.business_path, d.tags], [["여신", "심사"], ["승인"]]);
  assert.equal(normalizeDocument({ ...base, classification: { document_type: "KNOWHOW", business_path: [], tags: [] } }).business_path, undefined, "빈 분류는 싣지 않음");
  assert.equal(d.document_type, "REGULATION");
  assert.equal(d.effective_from, 20261101);
  assert.equal(d.effective_to, 99991231);
  assert.equal(normalizeDocument({ ...base, document_type: "KNOWHOW", effective_from: 20260101 }).effective_from, 20260101);
  assert.throws(() => normalizeDocument(base), { name: "UnclassifiedDocument" });
});

test("KbIngest clientToken은 Bedrock 제약(영숫자·하이픈, 33~256자)을 만족하고 결정적", async () => {
  const { ingestToken } = await import("./kb-ingest.ts");
  const t = ingestToken(input);
  assert.match(t, /^[a-zA-Z0-9](-*[a-zA-Z0-9]){32,255}$/u);
  assert.equal(t, ingestToken({ ...input }));
  assert.notEqual(t, ingestToken({ ...input, version: 2 }));
});

test("AgentCore Gateway Target 호출: __actor·task_token·outcome 등 추가 필드는 무시 (공통 입력 6필드만 사용)", () => {
  const e = { ...input, __actor: { sub: "x", groups: ["PLATFORM_OPERATOR"] }, task_token: "t", outcome: "PUBLISHED", extra: 1 };
  assert.deepEqual(StepInputSchema.parse(e), input);
});

test("KbIngest: 다른 문서 색인 중(ConflictException)이면 PENDING → 재호출 시 시작", async () => {
  const s = new MemoryObjectStore(); const r = new MemoryRecords();
  r.documents.set(DOC, { doc_id: DOC, version: 1, title: "K", document_type: "KNOWHOW", authority_status: "VERIFIED", dept: "여신", acl_groups: ["ALL"] });
  let busy = true; let started = 0;
  const api: IngestionApi = {
    start: async () => { if (busy) throw Object.assign(new Error("ongoing ingestion job"), { name: "ConflictException" }); started++; return "JOB1"; },
    get: async () => ({ status: "COMPLETE", failed: 0, failureReasons: [] }),
  };
  const env = { KB_ID: "KB", KB_DS_LEGAL_ID: "L", KB_DS_KNOWLEDGE_ID: "K", BUCKET_ARTIFACT: "art" };
  assert.equal((await kbIngestStep(input, api, r, s, env)).status, "PENDING");
  assert.equal(started, 0);
  busy = false;
  assert.equal((await kbIngestStep(input, api, r, s, env)).status, "PENDING");
  assert.equal(started, 1);
  assert.equal((await kbIngestStep(input, api, r, s, env)).status, "OK");
  const boom: IngestionApi = { ...api, start: async () => { throw Object.assign(new Error("denied"), { name: "AccessDeniedException" }); } };
  await assert.rejects(kbIngestStep({ ...input, version: 2 }, boom, r, s, env), /denied/u);
});

test("Promote: 마스킹 세그먼트의 figures를 본문 끝에 페이지 표시와 함께 싣는다 (묘사 없는 그림은 제외)", async () => {
  const s = new MemoryObjectStore(); const r = new MemoryRecords();
  const original = Buffer.from("SYNTHETIC 노하우");
  await s.put(Q, `${DOC}/original.md`, original);
  await s.put(Q, `${DOC}/work/text_layer.json`, JSON.stringify({ page_count: 2 }));
  await s.put(Q, `${DOC}/masked/segments/0000.json`, JSON.stringify({ text: "1쪽 본문" }));
  await s.put(Q, `${DOC}/masked/segments/0001.json`, JSON.stringify({ text: "2쪽 본문", figures: [{ kind: "사진", description: "현장 실사 사진", intent: "실사 예시" }, { kind: "아이콘", description: " " }] }));
  r.documents.set(DOC, { doc_id: DOC, version: 1, title: "K", document_type: "KNOWHOW", authority_status: "VERIFIED", dept: "여신", acl_groups: ["ALL"] });
  r.approvals.set("apr_f", { approval_id: "apr_f", doc_id: DOC, version: 1, content_hash: sha256(original), status: "APPROVED" });
  const out = await promoteStep({ ...input, published_bucket: P }, s, r);
  assert.equal((await s.get(P, out.output_key!)).toString(), "1쪽 본문\n2쪽 본문\n⟦그림 p1⟧ 사진: 현장 실사 사진 / 의도: 실사 예시");
});

test("올린 사람용 안내: 파일 문제는 BLOCKED + 사유·조치, 스캔 쪽은 쪽 번호와 함께 (사용자 지시 11/17)", async () => {
  const s = new MemoryObjectStore();
  await s.put(Q, `${DOC}/original.xlsx`, Buffer.from("x"));
  const u = await textLayerStep(input, s);
  assert.equal(u.status, "BLOCKED");
  assert.equal(u.findings![0]!.code, "UNSUPPORTED_FORMAT");
  assert.match(u.findings![0]!.user_message!, /\.xlsx 형식/u);
  assert.match(u.findings![0]!.fix_hint!, /PDF·DOCX·HWPX/u);
  const s2 = new MemoryObjectStore();
  await s2.put(Q, `${DOC}/original.pdf`, Buffer.from("%PDF-1.7\n깨진 파일"));
  assert.equal((await textLayerStep(input, s2)).findings![0]!.code, "CORRUPT_PDF");
  const s3 = new MemoryObjectStore();
  await s3.put(Q, `${DOC}/original.docx`, Buffer.from("zip 아님"));
  assert.equal((await textLayerStep(input, s3)).findings![0]!.code, "CORRUPT_OFFICE");
  // 모든 쪽 OCR이 기본이라 스캔 쪽 안내는 없음. document.pdf가 있으면 그 쪽 수
  const s4 = new MemoryObjectStore();
  await s4.put(Q, `${DOC}/original.docx`, Buffer.from("zip 아님"));
  await s4.put(Q, `${DOC}/work/document.pdf`, tinyPdf(["a", "b", "c"]));
  const ok = await textLayerStep(input, s4);
  assert.equal(ok.status, "OK");
  assert.equal(ok.findings, undefined);
  assert.equal(JSON.parse((await s4.get(Q, `${DOC}/work/text_layer.json`)).toString()).page_count, 3);
  // DOCX인데 변환본이 깨졌으면 CORRUPT_OFFICE 차단이 아니라 예외(재시도)
  const s5 = new MemoryObjectStore();
  await s5.put(Q, `${DOC}/original.docx`, Buffer.from("zip 아님"));
  await s5.put(Q, `${DOC}/work/document.pdf`, Buffer.from("깨진 변환본"));
  await assert.rejects(textLayerStep(input, s5), { name: "ConvertedPdfInvalid" });
});

test("조문 구조 이상은 쪽·문장 위치로 안내, 문장 일부는 개인정보를 가린 뒤 담음, 부칙은 제외", async () => {
  const { structureFindings } = await import("./segment.ts");
  const segs = [
    { page_index: 0, text: "제1조(목적) 가.\n제2조(정의) 나." },
    { page_index: 1, text: "제5조(보관) 다.\n제4조(문의) 담당 800101-1234567 에게 문의한다.\n부칙\n제1조(시행일) 시행.\n제1조(경과) 중복" },
  ];
  const f = structureFindings(segs, "w");
  assert.equal(f.length, 1);
  assert.equal(f[0]!.location!.page, 2);
  assert.match(f[0]!.location!.excerpt!, /\[주민등록번호\]/u);
  assert.doesNotMatch(JSON.stringify(f), /1234567/u, "원문 식별값 금지");
  assert.match(f[0]!.user_message!, /^2쪽 .*번호 순서/u);
  assert.deepEqual(structureFindings([{ page_index: 0, text: "노하우 메모: 제12조 참고" }], "w"), [], "조문형 문서가 아니면 검사 안 함");
});

test("Promote 예외는 올린 사람이 읽는 문장 + 조치 (Registry에 없는 규정)", async () => {
  const s = new MemoryObjectStore(); const r = new MemoryRecords();
  const original = Buffer.from("SYNTHETIC 규정");
  await s.put(Q, `${DOC}/original.md`, original);
  await s.put(Q, `${DOC}/work/text_layer.json`, JSON.stringify({ page_count: 1 }));
  await s.put(Q, `${DOC}/masked/segments/0000.json`, JSON.stringify({ text: "제1조(목적) 목적." }));
  r.documents.set(DOC, { doc_id: DOC, version: 1, title: "R", document_type: "REGULATION", authority_status: "UNVERIFIED", dept: "여신", acl_groups: ["ALL"] });
  r.approvals.set("apr_r", { approval_id: "apr_r", doc_id: DOC, version: 1, content_hash: sha256(original), status: "APPROVED" });
  await assert.rejects(promoteStep({ ...input, published_bucket: P }, s, r), (e: Error & { user_message?: string; fix_hint?: string }) =>
    e.name === "RegulationNotInRegistry" && /Registry/u.test(e.user_message!) && /노하우/u.test(e.fix_hint!) && /\(조치: /u.test(e.message));
  assert.equal(r.approvals.get("apr_r")!.status, "APPROVED", "게시 실패 시 승인 미소비");
});

test("12: 삭제 흐름(interfaces 6.0) — 분류 전 문서는 색인된 적이 없어 Job 없이 OK, 게시본 없는 삭제 문서도 document_type으로 데이터 소스 선택", async () => {
  const env = { KB_ID: "kb", KB_DS_LEGAL_ID: "ds-legal", KB_DS_KNOWLEDGE_ID: "ds-know", BUCKET_ARTIFACT: "art" };
  const api: IngestionApi = { start: async (_k, ds) => { assert.equal(ds, "ds-legal"); return "job-d"; }, get: async () => ({ status: "COMPLETE", failed: 0, failureReasons: [] }) };
  const unclassified = { getDocument: async () => { throw Object.assign(new Error("x"), { name: "UnclassifiedDocument" }); } } as unknown as MemoryRecords;
  assert.equal((await kbIngestStep(input, { start: async () => assert.fail("Job 시작 안 함"), get: api.get }, unclassified, new MemoryObjectStore(), env, true)).status, "OK");
  await assert.rejects(kbIngestStep(input, api, unclassified, new MemoryObjectStore(), env), { name: "UnclassifiedDocument" }, "게시 흐름에서는 그대로 오류");
  const r = new MemoryRecords();
  r.documents.set(DOC, { doc_id: DOC, version: 1, title: "R", document_type: "REGULATION", authority_status: "VERIFIED", dept: "여신", acl_groups: ["ALL"], lifecycle: "DELETED" });
  const s = new MemoryObjectStore(); // published 객체 없음
  assert.equal((await kbIngestStep({ ...input, workflow_id: "wf-del" }, api, r, s, env)).status, "PENDING");
  assert.equal((await kbIngestStep({ ...input, workflow_id: "wf-del" }, api, r, s, env)).status, "OK");
});

test("단계 Finding 저장: MemoryRecords.saveFindings는 같은 단계 것만 교체", async () => {
  const r = new MemoryRecords();
  const f = (step: string, code: string) => ({ finding_id: code, step, severity: "HIGH" as const, code, message: code, evidence_ref: "e" });
  await r.saveFindings(DOC, "TextLayerExtract", [f("TextLayerExtract", "A")]);
  await r.saveFindings(DOC, "SegmentBuild", [f("SegmentBuild", "NO_TEXT")]);
  await r.saveFindings(DOC, "SegmentBuild", [f("SegmentBuild", "NO_TEXT2")]);
  assert.deepEqual(r.findings.get(DOC)!.map((x) => x.code), ["A", "NO_TEXT2"]);
});

test("표(PP-StructureV3): 표 영역 줄 대신 제자리에 마크다운 표, tables 없으면 줄 나열 그대로", async () => {
  const { ocrPageText, tableToMarkdown } = await import("./segment.ts");
  assert.equal(tableToMarkdown("<table><tr><td>구분</td><td>기준</td></tr><tr><td>금고 열쇠</td><td>보라색확인절차 서명 | 필수</td></tr><tr><td colspan=2>예외는 영업점장 보고</td></tr></table>"),
    "| 구분 | 기준 |\n| --- | --- |\n| 금고 열쇠 | 보라색확인절차 서명 \\| 필수 |\n| 예외는 영업점장 보고 |  |");
  // rowspan: 아래 행 값이 다른 열로 밀리지 않음 (PR #27 리뷰)
  assert.equal(tableToMarkdown("<tr><td rowspan=2>A</td><td>B</td><td>C</td></tr><tr><td>D</td><td>E</td></tr>"), "| A | B | C |\n| --- | --- | --- |\n|  | D | E |");
  // 닫는 태그 누락·엔티티
  assert.equal(tableToMarkdown("<tr><td>a<td>b&quot;&#39;</tr>"), "| a | b\"' |\n| --- | --- |");
  assert.equal(tableToMarkdown("<table></table>"), "");
  // 행이 rowspan 열 전에 끝나도 다음 행이 밀리지 않음 (재리뷰)
  assert.equal(tableToMarkdown("<tr><td>a</td><td rowspan=3>R</td></tr><tr><td>b</td></tr><tr><td>c</td></tr><tr><td>d</td><td>e</td></tr>"),
    "| a | R |\n| --- | --- |\n| b |  |\n| c |  |\n| d | e |");
  const b = (text: string, y: number, table_id: string | null = null) => ({ block_id: text, label: table_id ? "table" : "text", text, confidence: 0.99, bbox: [0, y, 100, y + 10], reading_order: y, table_id });
  const blocks = [b("영업점 마감 노하우", 0), b("구분", 50, "p0-t0"), b("기준", 50, "p0-t0"), b("표 아래 문장", 200)];
  assert.equal(ocrPageText(blocks), "영업점 마감 노하우\n구분 기준\n표 아래 문장");
  assert.equal(ocrPageText(blocks, [{ table_id: "p0-t0", bbox: [0, 40, 100, 120], html: "<tr><td>구분</td><td>기준</td></tr>" }]),
    "영업점 마감 노하우\n\n| 구분 | 기준 |\n| --- | --- |\n\n표 아래 문장");
  // 표 HTML이 비면 글자를 잃지 않고 줄 나열 (PR #27 리뷰)
  assert.equal(ocrPageText(blocks, [{ table_id: "p0-t0", bbox: [0, 40, 100, 120], html: "" }]), "영업점 마감 노하우\n구분 기준\n표 아래 문장");
  // bbox 없는 블록이 섞이면 원래 순서에서 표 첫 줄 자리에
  const nb = blocks.map((x, i) => (i === 0 ? { ...x, bbox: [] } : x));
  assert.equal(ocrPageText(nb, [{ table_id: "p0-t0", bbox: [0, 40, 100, 120], html: "<tr><td>구분</td></tr>" }]), "영업점 마감 노하우\n\n| 구분 |\n| --- |\n\n표 아래 문장");
  // 표에만 bbox가 없으면 표 첫 줄의 세로 위치 (재리뷰)
  assert.equal(ocrPageText(blocks, [{ table_id: "p0-t0", bbox: [], html: "<tr><td>구분</td></tr>" }]), "영업점 마감 노하우\n\n| 구분 |\n| --- |\n\n표 아래 문장");
});

test("쪽 넘김 문맥: 항 번호만 이어 가고 잘못 읽힌 조 번호는 번지지 않음, 글자 그대로 쓴 쪽에서 초기화 (PR #28 리뷰)", async () => {
  const { buildSegments } = await import("./segment.ts");
  const blk = (text: string, i: number) => ({ block_id: `b${i}`, label: "text", text, confidence: 0.99, bbox: [0, i * 20, 100, i * 20 + 10], reading_order: i, table_id: null });
  const pg = (i: number, lines: string[]) => ({ page_index: i, width: 100, height: 100, source: "ocr", blocks: lines.map(blk) });
  const layer = (n: number, textPages: number[] = []) => ({ doc_id: "D", source_ext: "pdf", page_count: n, pages: Array.from({ length: n }, (_, i) => ({ page_index: i, text: textPages.includes(i) ? "부칙" : "", char_count: 0, broken_ratio: 0, needs_ocr: !textPages.includes(i) })) });
  const ocr = (pages: ReturnType<typeof pg>[]) => ({ doc_id: "D", model: "m", model_version: "v", page_count: pages.length, pages });
  // 1쪽 본문 인용 "제 25 조 각 호의…"가 있어도 2쪽 "제11조(승인)1 …"은 ①로
  const s1 = buildSegments(layer(2), ocr([pg(0, ["제10조(심사) ① 심사역은", "제 25 조 각 호의 서류를 받는다."]), pg(1, ["제11조(승인)1 여신 승인은", "2 금액이"])]));
  assert.match(s1[1]!.text, /제11조\(승인\) ① 여신 승인은\n② 금액이/u);
  // 2쪽이 글자 그대로 쓴 쪽이면 3쪽은 새 문맥
  const s2 = buildSegments(layer(3, [1]), ocr([pg(0, ["제30조(시행) ① 시행한다"]), pg(1, []), pg(2, ["2 이 규정 시행 당시"])]));
  assert.equal(s2[2]!.text, "2 이 규정 시행 당시");
});

test("그림 속 글자(화면 캡처): 본문 흐름에서 빼고 자리에 [그림 n], 쪽 끝에 ⟦그림 p⟧ 줄, 저신뢰 판정 제외 (사용자 지적 11/17)", async () => {
  const { ocrPageText, buildSegments } = await import("./segment.ts");
  const b = (text: string, y: number, label = "text", confidence = 0.99) => ({ block_id: text, label, text, confidence, bbox: [10, y, 300, y + 10], reading_order: y, table_id: null });
  const blocks = [b("1. 스캐너 설정을 엽니다", 0), b("Wivdoms7/8/83/10020ut", 60, "image", 0.41), b("V1o Pivivg& Scen", 80, "image", 0.38), b("2. 확인을 누릅니다", 200)];
  const figures = [{ label: "image", bbox: [0, 50, 400, 150] }];
  assert.equal(ocrPageText(blocks, [], figures, 3),
    "1. 스캐너 설정을 엽니다\n[그림 1]\n2. 확인을 누릅니다\n⟦그림 p3⟧ 그림 1 속 글자: Wivdoms7/8/83/10020ut V1o Pivivg& Scen");
  // 영역 정보 없이 image 라벨만 있어도 같은 처리, 그림이 없으면 기존과 같음
  assert.match(ocrPageText(blocks, [], [], 0), /^1\. 스캐너 설정을 엽니다\n\[그림 1\]\n2\. 확인을 누릅니다\n⟦그림 p0⟧ 그림 1 속 글자: /u);
  assert.equal(ocrPageText([blocks[0]!, blocks[3]!]), "1. 스캐너 설정을 엽니다\n2. 확인을 누릅니다");
  // 저신뢰: 그림 속 줄(0.4)과 빈 덩어리(0)는 판정에서 뺀다
  const layer = { doc_id: "D", source_ext: "pdf", page_count: 1, pages: [{ page_index: 0, text: "", char_count: 0, broken_ratio: 0, needs_ocr: true }] };
  const seg = buildSegments(layer, { doc_id: "D", model: "m", model_version: "v", page_count: 1, pages: [{ page_index: 0, width: 400, height: 300, source: "ocr", blocks: [...blocks, b("", 250, "text", 0)], figures }] })[0]!;
  assert.equal(seg.low_confidence, false);
});

test("그림 분리 안전장치 (PR #33 리뷰): 사진만 있는 쪽은 NO_TEXT, text 라벨 줄은 그림 bbox와 겹쳐도 본문, 쪽 덮는 그림·직인은 분리 안 함, 자르기는 낱말 경계", async () => {
  const { ocrPageText, segmentStep } = await import("./segment.ts");
  const b = (text: string, y: number, label = "text", confidence = 0.99) => ({ block_id: text + y, label, text, confidence, bbox: [10, y, 300, y + 10], reading_order: y, table_id: null });
  // 1) 글자 없는 사진만: NO_TEXT 차단
  const s = new MemoryObjectStore();
  await s.put(Q, `${DOC}/work/text_layer.json`, JSON.stringify({ doc_id: DOC, source_ext: "pdf", page_count: 1, pages: [{ page_index: 0, text: "", char_count: 0, broken_ratio: 0, needs_ocr: true }] }));
  await s.put(Q, `${DOC}/work/ocr/result.json`, JSON.stringify({ doc_id: DOC, model: "m", model_version: "v", page_count: 1, pages: [{ page_index: 0, width: 400, height: 300, source: "ocr", blocks: [], figures: [{ label: "image", bbox: [0, 0, 200, 200] }] }] }));
  const out = await segmentStep(input, s);
  assert.equal(out.status, "BLOCKED");
  assert.equal(out.findings![0]!.code, "NO_TEXT");
  // 2) 레이아웃이 text로 붙인 줄은 image bbox 안이어도 본문
  const lines = [b("제1조(목적) 이 규정은", 20), b("은행 업무를 정한다", 40)];
  assert.equal(ocrPageText(lines, [], [{ label: "image", bbox: [0, 0, 300, 100] }], 0, { width: 400, height: 300 }), "[그림 1]\n제1조(목적) 이 규정은\n은행 업무를 정한다"); // 자리 표시는 그림 위쪽 경계 위치
  // 3) 쪽을 거의 덮는 그림(옛 형식 줄)은 그림으로 보지 않음
  const legacy = lines.map((x) => ({ ...x, label: "paragraph" }));
  assert.equal(ocrPageText(legacy, [], [{ label: "image", bbox: [0, 0, 400, 300] }], 0, { width: 400, height: 300 }), "제1조(목적) 이 규정은\n은행 업무를 정한다");
  // 4) 직인(seal) 영역 줄은 본문에 남김
  assert.equal(ocrPageText([b("은행장 홍길동", 20, "seal")], [], [{ label: "seal", bbox: [0, 0, 100, 100] }]), "은행장 홍길동");
  // 3-1) 쪽 전체 image 영역 안 줄은 label이 image여도 본문 (재리뷰 HIGH-A)
  const imgLines = lines.map((x) => ({ ...x, label: "image" }));
  assert.equal(ocrPageText(imgLines, [], [{ label: "image", bbox: [0, 0, 400, 300] }], 0, { width: 400, height: 300 }), "제1조(목적) 이 규정은\n은행 업무를 정한다");
  // 3-2) 표 bbox 안 줄(table_id 없음)은 마크다운 표로 한 번만 (재리뷰 MEDIUM-B)
  const tl = [b("구분", 60, "text"), b("기준", 60, "text"), b("표 아래", 200)];
  assert.equal(ocrPageText(tl, [{ table_id: "t0", bbox: [0, 50, 400, 100], html: "<tr><td>구분</td><td>기준</td></tr>" }]), "| 구분 | 기준 |\n| --- | --- |\n\n표 아래");
  // 5) 1,500자 자르기는 낱말 경계 (주민등록번호가 반만 남지 않게)
  const long = `${"가".repeat(1490)} 900101-1234568 끝`;
  const t = ocrPageText([b(long, 50, "image", 0.5)], [], [{ label: "image", bbox: [0, 0, 400, 300] }]);
  assert.ok(!/900101-12/u.test(t) && t.endsWith("…"));
});
