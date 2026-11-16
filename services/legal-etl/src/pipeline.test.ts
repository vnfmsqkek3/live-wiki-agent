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

test("3a: PDF 페이지별 글자 수로 OCR 대상 판정, 미지원 형식은 실패", async () => {
  const layer = await extractTextLayer(tinyPdf(["SYNTHETIC Hanbit Bank loan regulation article 12 approval threshold text", ""]), "pdf", DOC);
  assert.equal(layer.page_count, 2);
  assert.equal(layer.pages[0]!.needs_ocr, false);
  assert.equal(layer.pages[1]!.needs_ocr, true);
  await assert.rejects(extractTextLayer(Buffer.from("x"), "docx", DOC)); // 깨진 DOCX(ZIP 아님)는 실패
  await assert.rejects(extractTextLayer(Buffer.from("x"), "xlsx", DOC), /지원하지 않는 형식/u);
});

test("5: OCR 필요한데 결과 없으면 실패, 저신뢰면 REVIEW_REQUIRED", async () => {
  const s = new MemoryObjectStore();
  await s.put(Q, `${DOC}/original.png`, readFileSync(new URL("documents/A-002.png", FIX)));
  await textLayerStep(input, s);
  await assert.rejects(segmentStep(input, s), /NoSuchKey/u);
  const ocr: OcrResult = { doc_id: DOC, model: "paddleocr", model_version: "test", page_count: 1, pages: [{ page_index: 0, width: 2000, height: 2828, source: "ocr", blocks: [
    { block_id: "p0-b1", label: "paragraph", text: "제12조(승인 기준)", confidence: 0.97, bbox: [0, 0, 1, 1], reading_order: 1, table_id: null },
    { block_id: "p0-b0", label: "title", text: "SYNTHETIC", confidence: 0.6, bbox: [0, 0, 1, 1], reading_order: 0, table_id: null },
  ] }] };
  await s.put(Q, `${DOC}/work/ocr/result.json`, JSON.stringify(ocr));
  const out = await segmentStep(input, s);
  assert.equal(out.status, "REVIEW_REQUIRED");
  assert.equal(out.findings![0]!.code, "LOW_OCR_CONFIDENCE");
  const seg = JSON.parse((await s.get(Q, `${DOC}/work/segments/0000.json`)).toString());
  assert.equal(seg.text, "SYNTHETIC\n제12조(승인 기준)"); // reading_order 정렬
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
  await assert.rejects(promoteStep(pin, s, r), /승인 바인딩/u); // 해시 불일치
  assert.equal((await s.list(P, "")).length, 0, "실패 시 published에 아무것도 없음");

  const out = await promoteStep({ ...pin, approval_id: "apr_1" }, s, r);
  assert.equal(out.output_key, `legal/${DOC}/content.txt`);
  assert.equal(r.approvals.get("apr_1")!.status, "USED");
  // 같은 워크플로 재시도는 허용(멱등), 다른 워크플로의 재사용은 차단
  assert.equal((await promoteStep({ ...pin, approval_id: "apr_1" }, s, r)).status, "OK");
  await assert.rejects(promoteStep({ ...pin, workflow_id: "wf_other", approval_id: "apr_1" }, s, r), /재사용/u);
  assert.match(out.content_hash!, /^sha256:/u);
  // 이전 실행의 잔여 마스킹 페이지가 섞이면 실패
  await s.put(Q, `${DOC}/masked/segments/0007.json`, JSON.stringify({ text: "옛 페이지" }));
  r.approvals.set("apr_2", { approval_id: "apr_2", doc_id: DOC, version: 1, content_hash: sha256(original), status: "APPROVED" });
  await assert.rejects(promoteStep({ ...pin, approval_id: "apr_2" }, s, r), /세그먼트 불일치/u);
  assert.equal(r.approvals.get("apr_2")!.status, "APPROVED", "게시 실패 시 승인을 소비하지 않음");
  // 규정인데 law_id 없음(Registry 대조 전) → 메타데이터 검증 실패, 승인은 그대로
  s.objects.delete(`${Q}/${DOC}/masked/segments/0007.json`);
  const full = r.documents.get(DOC)!;
  r.documents.set(DOC, { ...full, law_id: undefined, revision_id: undefined });
  await assert.rejects(promoteStep({ ...pin, approval_id: "apr_2" }, s, r), /law_id/u);
  assert.equal(r.approvals.get("apr_2")!.status, "APPROVED");
  r.documents.set(DOC, full);

  const meta = MetadataSidecar.parse(JSON.parse((await s.get(P, `legal/${DOC}/content.txt.metadata.json`)).toString())).metadataAttributes;
  assert.equal(meta.index_group, "legal-clauses");
  assert.equal(meta.effective_from, 20261101);
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
  await assert.rejects(kbIngestStep(input, api, r, s, env), /실패 문서 1건/u);
  state = { status: "COMPLETE", failed: 0, failureReasons: [] };
  assert.equal((await kbIngestStep(input, api, r, s, env)).status, "OK");
  state = { status: "FAILED", failed: 0, failureReasons: ["x"] };
  await assert.rejects(kbIngestStep(input, api, r, s, env), /FAILED/u);
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
