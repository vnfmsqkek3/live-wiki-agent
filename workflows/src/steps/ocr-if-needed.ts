// 단계 4 OcrIfNeeded (docs/04 2장, Owner yoyo0704). 폴링 단계: 15초마다 같은 입력으로 다시 불린다.
// 상태는 전부 S3 키로 판단한다 (멱등):
//   _ocr-async/in/{doc}/chunk_{i}.json        요청 본문 (있으면 이미 호출함)
//   {doc}/work/ocr/chunks/chunk_{i}.pending   SageMaker 출력·실패 위치
//   {doc}/work/ocr/chunks/chunk_{i}.json      청크 결과
//   {doc}/work/ocr/result.json               병합 결과 (있으면 완료)
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { InvokeEndpointAsyncCommand, SageMakerRuntimeClient } from "@aws-sdk/client-sagemaker-runtime";
import { finding, type Finding, type StepInput, type StepOutput } from "./common.js";
import { findingsStore, type FindingsStore } from "./findings-store.js";
import type { OcrTargets } from "./page-render.js";

const STEP = "OcrIfNeeded";
export const CHUNK = 10;
export const LOW_BLOCK = 0.85;
export const LOW_PAGE = 0.9;

type Block = { confidence: number; bbox: number[]; label?: string; text?: string }; // bbox: 렌더 PNG 픽셀 [x0,y0,x1,y1] (services/ocr convert.py)
type Page = { page_index: number; blocks: Block[] };
type ChunkResult = { model: string; model_version: string; pages: Page[] };

export type Deps = {
  get: (key: string) => Promise<string | undefined>; // quarantine 버킷, 없으면 undefined
  put: (key: string, body: string) => Promise<void>;
  move: (srcUri: string, key: string) => Promise<boolean>; // s3 uri → quarantine key. 원본 없으면 false
  exists: (uri: string) => Promise<boolean>;
  invoke: (inputKey: string, inferenceId: string) => Promise<{ output: string; failure: string }>;
  saveFindings: FindingsStore;
};

// let522mj SegmentBuild 기준과 같게: 그림은 image·figure·chart (seal 직인은 본문), 글자 없는 덩어리는 제외
export const PASS_PAGE = 0.95;
export const FIGURE_LABELS = new Set(["image", "figure", "chart"]);

// 저신뢰 판정: 블록 < 0.85 또는 페이지 평균 < 0.9 → OCR·PII 검토 화면 표시 (기준치는 실측 후 조정)
/** 쪽 본문 평균 신뢰도 (그림 안 글자·빈 덩어리 제외). 본문이 없으면 undefined */
export function pageAvg(p: Page): number | undefined {
  const body = p.blocks.filter((b) => !FIGURE_LABELS.has(b.label ?? "") && (b.text === undefined || b.text.trim() !== ""));
  return body.length ? body.reduce((s, b) => s + b.confidence, 0) / body.length : undefined;
}

export function lowConfidence(doc_id: string, pages: Page[]): Finding[] {
  const out: Finding[] = [];
  for (const p of pages) {
    // 그림(캡처·사진) 안 글자는 본문이 아니라 그림의 일부 → 본문 신뢰도 판정에서 뺀다 (11/17 과천사옥 매뉴얼: 캡처 속 작은 UI 글자 1,823줄 평균 0.74가 쪽마다 경고)
    const body = p.blocks.filter((b) => !FIGURE_LABELS.has(b.label ?? "") && (b.text === undefined || b.text.trim() !== ""));
    if (body.length === 0) continue;
    const avg = body.reduce((s, b) => s + b.confidence, 0) / body.length;
    const lowBlocks = body.filter((b) => b.confidence < LOW_BLOCK);
    const low = lowBlocks.length;
    if (avg >= PASS_PAGE) continue; // 사용자 결정 11/18: 쪽 평균 95% 이상이면 경고 없이 통과
    if (avg < LOW_PAGE || low > 0) {
      out.push(finding(STEP, avg < LOW_PAGE ? "MEDIUM" : "LOW", "OCR_LOW_CONFIDENCE",
        `저신뢰 페이지 ${p.page_index + 1}: 평균 ${avg.toFixed(2)}, 저신뢰 블록 ${low}개`, `${doc_id}/work/ocr/result.json#page=${p.page_index}`, {
          // 글자 내용은 마스킹 전이라 넣지 않고 위치만 (가장 불확실한 5곳)
          location: { page: p.page_index + 1, bbox: [...lowBlocks].sort((a, b) => a.confidence - b.confidence).slice(0, 5).map((b) => b.bbox) },
          user_message: `${p.page_index + 1}쪽에서 글자를 확실히 읽지 못한 부분이 ${low}곳 있습니다 (평균 인식 신뢰도 ${(avg * 100).toFixed(0)}%). 표시된 영역의 글자가 원문과 다를 수 있습니다.`,
          fix_hint: "표시된 영역이 흐리거나 기울어졌거나 손글씨인지 확인해 주세요. 300dpi 이상으로 반듯하게 다시 스캔하거나, 가능하면 글자가 선택되는 PDF 원본을 올려 주세요.",
        }));
    }
  }
  return out;
}

export function makeHandler(d: Deps) {
  return async (e: StepInput): Promise<StepOutput> => {
    const work = `${e.doc_id}/work/ocr`;
    const resultKey = `${work}/result.json`;
    const targetsRaw = await d.get(`${e.doc_id}/work/pages/ocr_targets.json`);
    if (!targetsRaw) throw new Error(`OcrTargetsNotFound: ${e.doc_id}`); // PageRender 선행 필수
    const targets = JSON.parse(targetsRaw) as OcrTargets;
    // OCR 대상이 없어도(글자 층 PDF·md) 빈 목록을 남긴다 — ImageDescribe 가 읽는 키 (11/18 없는 키 → 403 으로 실패)
    if (targets.pages.length === 0) { await d.put(`${e.doc_id}/masked/ocr_low_pages.json`, JSON.stringify({ doc_id: e.doc_id, low_pages: [] })); return { status: "OK" }; }
    if (await d.get(resultKey)) return { status: "OK", output_key: resultKey }; // 이미 완료 (재호출)

    const chunks: ChunkResult[] = [];
    let pending = false;
    for (let i = 0; i * CHUNK < targets.pages.length; i++) {
      const name = `chunk_${String(i).padStart(4, "0")}`;
      const done = await d.get(`${work}/chunks/${name}.json`);
      if (done) { chunks.push(JSON.parse(done) as ChunkResult); continue; }
      pending = true;

      const marker = await d.get(`${work}/chunks/${name}.pending`);
      if (!marker) {
        const inputKey = `_ocr-async/in/${e.doc_id}/${name}.json`;
        await d.put(inputKey, JSON.stringify({ doc_id: e.doc_id, bucket: e.bucket, pages: targets.pages.slice(i * CHUNK, (i + 1) * CHUNK) }));
        const loc = await d.invoke(inputKey, `${e.workflow_id}-${name}`);
        await d.put(`${work}/chunks/${name}.pending`, JSON.stringify(loc));
        continue;
      }
      const loc = JSON.parse(marker) as { output: string; failure: string };
      if (await d.move(loc.output, `${work}/chunks/${name}.json`)) {
        const moved = await d.get(`${work}/chunks/${name}.json`);
        chunks.push(JSON.parse(moved!) as ChunkResult);
        continue;
      }
      if (await d.exists(loc.failure)) throw new Error(`OcrChunkFailed: ${e.doc_id} ${name}`);
    }
    if (chunks.length * CHUNK < targets.pages.length && pending) return { status: "PENDING" };

    const pages = chunks.flatMap((c) => c.pages).sort((a, b) => a.page_index - b.page_index);
    await d.put(resultKey, JSON.stringify({ doc_id: e.doc_id, model: chunks[0]!.model, model_version: chunks[0]!.model_version, page_count: targets.page_count, pages }));
    // 인식률 95% 미만 쪽은 ImageDescribe 가 Sonnet Vision 으로 다시 읽는다(사용자 결정 11/18). 쪽 번호·평균만, 글자 없음 → masked/ 에 둠
    const low_pages = pages.filter((p) => (pageAvg(p) ?? 1) < PASS_PAGE).map((p) => p.page_index);
    await d.put(`${e.doc_id}/masked/ocr_low_pages.json`, JSON.stringify({ doc_id: e.doc_id, low_pages }));
    // 사용자 결정 11/18 "경고는 없애줘": 95% 미만 쪽은 Vision 이 다시 읽으므로 OCR 저신뢰 경고를 내지 않는다 (lowConfidence 는 기준 기록용으로 남김)
    await d.saveFindings(e.doc_id, STEP, []);
    return { status: "OK", output_key: resultKey };
  };
}

// ---------- AWS 연결 ----------
const s3 = new S3Client({});
const sm = new SageMakerRuntimeClient({});
const BUCKET = process.env.BUCKET_QUARANTINE ?? "";
const parse = (uri: string) => { const u = new URL(uri); return { Bucket: u.hostname, Key: decodeURIComponent(u.pathname.slice(1)) }; };
const notFound = (err: unknown) => (err as { name?: string }).name === "NoSuchKey" || (err as { name?: string }).name === "NotFound";

export const handler = makeHandler({
  get: async (Key) => {
    try { return await (await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key }))).Body!.transformToString(); }
    catch (err) { if (notFound(err)) return undefined; throw err; }
  },
  put: async (Key, Body) => {
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body, ContentType: "application/json", ServerSideEncryption: "aws:kms" }));
  },
  move: async (uri, Key) => {
    const src = parse(uri);
    try { await s3.send(new HeadObjectCommand(src)); } catch (err) { if (notFound(err)) return false; throw err; }
    await s3.send(new CopyObjectCommand({ Bucket: BUCKET, Key, CopySource: `${src.Bucket}/${encodeURIComponent(src.Key)}`, ServerSideEncryption: "aws:kms" }));
    await s3.send(new DeleteObjectCommand(src));
    return true;
  },
  exists: async (uri) => {
    try { await s3.send(new HeadObjectCommand(parse(uri))); return true; } catch (err) { if (notFound(err)) return false; throw err; }
  },
  invoke: async (inputKey, inferenceId) => {
    const r = await sm.send(new InvokeEndpointAsyncCommand({
      EndpointName: process.env.OCR_ENDPOINT_NAME, InputLocation: `s3://${BUCKET}/${inputKey}`,
      ContentType: "application/json", InferenceId: inferenceId.slice(0, 64), InvocationTimeoutSeconds: 3600,
    }));
    return { output: r.OutputLocation!, failure: r.FailureLocation! };
  },
  saveFindings: findingsStore(),
});
