// 13항 12번: OCR 결과 문장이 원문과 정확히 일치하는지 — 정답을 아는 합성 규정을 이미지로 그려 실제 OCR 엔드포인트에 넣고 대조.
// 지표: 문자 오류율 CER(공백 제외 편집 거리 / 정답 글자 수), 줄 정확 일치율, 조문 구조(조·항·호 경로) 복원율.
// 실행 (공유 dev, Chrome 필요): set -a; . ./.env.local; set +a; node tests/evaluations/cases/src/measure-ocr.ts [F-001 G-REG-01 ...]
// 측정용 객체는 quarantine 버킷 {evalDoc}/work/pages/, _ocr-async/in/{evalDoc}/ 에 올리고 끝나면 지운다.
import { parseLaw } from "@hanaeum/legal-parser";

const squash = (s: string) => s.replace(/\s+/gu, "");

/** 편집 거리 (두 줄 DP, 코드포인트 단위) */
export function editDistance(a: string, b: string): number {
  const x = [...a]; const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length]!;
}
/** 공백을 뺀 문자 오류율 (줄바꿈·띄어쓰기 차이는 오류로 보지 않음) */
export const cer = (ref: string, hyp: string) => { const r = squash(ref); return r.length ? editDistance(r, squash(hyp)) / [...r].length : 0; };

export interface Block { text: string; bbox: number[] }
/** OCR 블록을 같은 줄끼리 묶는다 (세로 중심이 줄 높이 절반 안이면 같은 줄), 왼→오른 순 */
export function rows(blocks: Block[]): string[] {
  const items = blocks.map((b) => ({ t: b.text, x: b.bbox[0]!, yc: (b.bbox[1]! + b.bbox[3]!) / 2, h: b.bbox[3]! - b.bbox[1]! })).sort((a, b) => a.yc - b.yc);
  const out: { yc: number; h: number; parts: typeof items }[] = [];
  for (const it of items) {
    const last = out.at(-1);
    if (last && Math.abs(it.yc - last.yc) < Math.max(last.h, it.h) / 2) last.parts.push(it); else out.push({ yc: it.yc, h: it.h, parts: [it] });
  }
  return out.map((r) => r.parts.sort((a, b) => a.x - b.x).map((p) => p.t).join(" "));
}

export interface OcrScore { cer: number; lines: number; lineExact: number; provisions: number; provisionsMatched: number }
/** 정답 줄 vs OCR 줄: CER, 줄 정확 일치(공백 무시), 조문 경로·본문 일치 */
export function score(refLines: string[], hypLines: string[]): OcrScore {
  const hyp = new Set(hypLines.map(squash));
  const meta = { law_id: "X", law_name: "x", revision_id: "2026-01-01" };
  const view = (t: string) => new Map(parseLaw(t, meta).provisions.map((p) => [p.provision_id, squash(p.normalized_text)]));
  const ref = view(refLines.join("\n")); const got = view(hypLines.join("\n"));
  return {
    cer: cer(refLines.join("\n"), hypLines.join("\n")),
    lines: refLines.length, lineExact: refLines.filter((l) => hyp.has(squash(l))).length,
    provisions: ref.size, provisionsMatched: [...ref].filter(([k, v]) => got.get(k) === v).length,
  };
}

if (import.meta.main) {
  const { execFileSync } = await import("node:child_process");
  const { readFileSync, writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const { SageMakerRuntimeClient, InvokeEndpointAsyncCommand } = await import("@aws-sdk/client-sagemaker-runtime");
  const ssm = (n: string) => execFileSync("aws", ["ssm", "get-parameter", "--name", `/hanaeum-mvp/dev/${n}`, "--query", "Parameter.Value", "--output", "text"]).toString().trim();
  const BUCKET = ssm("BUCKET_QUARANTINE"); const ENDPOINT = ssm("OCR_ENDPOINT_NAME");
  const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const FIX = new URL("../../../fixtures/", import.meta.url);
  const LINES_PER_PAGE = 12;
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : ["F-001", "G-REG-01", "G-REG-06"];
  const s3 = new S3Client({}); const sm = new SageMakerRuntimeClient({});
  const evalDoc = `doc_OCREVAL${Date.now()}`;
  const tmp = mkdtempSync(join(tmpdir(), "ocr-eval-"));
  const esc = (s: string) => s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;");
  const truth: { id: string; lines: string[] }[] = [];
  try {
    // 1) 정답 페이지 이미지 (Chrome headless, Noto Sans KR 웹폰트)
    for (const id of ids) {
      const lines = readFileSync(new URL(id.startsWith("G-") ? `golden/${id}.txt` : `documents/${id}.txt`, FIX), "utf8").split("\n").filter((l) => l.trim());
      for (let i = 0; i < lines.length; i += LINES_PER_PAGE) {
        const page = lines.slice(i, i + LINES_PER_PAGE); const n = truth.length;
        const html = join(tmp, "p.html"); const png = join(tmp, `${n}.png`);
        writeFileSync(html, `<!doctype html><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400&display=block" rel="stylesheet"><body style="margin:40px;background:#fff;font:28px/1.9 'Noto Sans KR',sans-serif;white-space:pre">${page.map(esc).join("\n")}</body>`);
        execFileSync(CHROME, ["--headless", "--disable-gpu", "--hide-scrollbars", "--window-size=2200,1100", "--virtual-time-budget=8000", `--screenshot=${png}`, `file://${html}`], { stdio: "ignore" });
        await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `${evalDoc}/work/pages/${String(n).padStart(4, "0")}.png`, Body: readFileSync(png), ServerSideEncryption: "aws:kms" }));
        truth.push({ id, lines: page });
      }
    }
    // 2) 실제 OCR (SageMaker Async)
    const req = { doc_id: evalDoc, bucket: BUCKET, pages: truth.map((_, n) => ({ page_index: n, key: `${evalDoc}/work/pages/${String(n).padStart(4, "0")}.png` })) };
    const inKey = `_ocr-async/in/${evalDoc}/req.json`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: inKey, Body: JSON.stringify(req), ServerSideEncryption: "aws:kms" }));
    const r = await sm.send(new InvokeEndpointAsyncCommand({ EndpointName: ENDPOINT, InputLocation: `s3://${BUCKET}/${inKey}`, ContentType: "application/json", InvocationTimeoutSeconds: 3600 }));
    const [ob, ...ok] = r.OutputLocation!.replace("s3://", "").split("/");
    let out: { pages: { page_index: number; blocks: Block[] }[] } | undefined;
    for (let t = 0; t < 90 && !out; t++) {
      try { out = JSON.parse(await (await s3.send(new GetObjectCommand({ Bucket: ob, Key: ok.join("/") }))).Body!.transformToString()); }
      catch (e) { if ((e as Error).name !== "NoSuchKey") throw e; await new Promise((res) => setTimeout(res, 10_000)); }
    }
    if (!out) throw new Error(`OCR 결과 없음 (15분 초과): ${r.OutputLocation} / 실패 위치 ${r.FailureLocation}`);
    // 3) 대조
    const byDoc = new Map<string, { ref: string[]; hyp: string[] }>();
    for (const p of out.pages) {
      const t = truth[p.page_index]!; const d = byDoc.get(t.id) ?? { ref: [], hyp: [] };
      d.ref.push(...t.lines); d.hyp.push(...rows(p.blocks)); byDoc.set(t.id, d);
    }
    console.log(`| 문서 | 쪽 | CER | 줄 정확 일치 | 조문 구조·본문 일치 |`);
    console.log(`|---|---|---|---|---|`);
    const all = { ref: [] as string[], hyp: [] as string[] };
    for (const [id, d] of byDoc) {
      const s = score(d.ref, d.hyp); all.ref.push(...d.ref); all.hyp.push(...d.hyp);
      console.log(`| ${id} | ${truth.filter((t) => t.id === id).length} | ${(s.cer * 100).toFixed(2)}% | ${s.lineExact}/${s.lines} | ${s.provisionsMatched}/${s.provisions} |`);
    }
    const s = score(all.ref, all.hyp);
    console.log(`| **전체** | ${truth.length} | **${(s.cer * 100).toFixed(2)}%** | ${s.lineExact}/${s.lines} | ${s.provisionsMatched}/${s.provisions} |`);
    console.log(`엔드포인트 ${ENDPOINT}, 모델 ${(out as { model?: string }).model ?? "?"}`);
    for (const [id, d] of byDoc) for (const l of d.ref) if (!new Set(d.hyp.map(squash)).has(squash(l))) console.log(`  불일치 ${id}: ${l.slice(0, 60)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    for (const prefix of [`${evalDoc}/`, `_ocr-async/in/${evalDoc}/`]) {
      const keys = ((await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }))).Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length) await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys } }));
    }
  }
}
