// 단계 5 SegmentBuild: 쪽별 세그먼트 (docs/04 1.1, 2.1). 본문은 OCR 결과 (TXT·MD와 변환 단계 배포 전 DOCX·HWPX만 text_layer)
import { ISSUE_TEXT, ocrRows, ocrRowsY, parseLaw, restoreCircled } from "@hanaeum/legal-parser";
import { detectPii, mask } from "@hanaeum/pii";
import { newId, defangFigureLine } from "@hanaeum/schemas";
import type { Finding, StepInput, StepOutput } from "@hanaeum/schemas";
import type { ObjectStore } from "./store.ts";
import type { TextLayer } from "./text-layer.ts";

export interface OcrBlock { block_id: string; label: string; text: string; confidence: number; bbox: number[]; reading_order: number; table_id: string | null }
/** tables: PP-StructureV3 표 (요청기록 20261117-2120). 없으면 줄 나열 (하위 호환) */
export interface OcrTable { table_id: string; bbox: number[]; html: string }
export interface OcrResult { doc_id: string; model: string; model_version: string; page_count: number; pages: { page_index: number; width: number; height: number; source: string; blocks: OcrBlock[]; tables?: OcrTable[]; figures?: { label: string; bbox: number[] }[] }[] }

const decode = (h: string) => h.replace(/&nbsp;/gu, " ").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, '"')
  .replace(/&#(x?)([0-9a-f]+);/giu, (_, x: string, n: string) => { const c = parseInt(n, x ? 16 : 10); return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : " "; })
  .replace(/&amp;/gu, "&");
const cellText = (h: string) => decode(h.replace(/<br\s*\/?>/giu, " ").replace(/<[^<>]*>/gu, " ")).replace(/\s+/gu, " ").trim().replace(/\|/gu, "\\|");
const attr = (a: string, k: string) => Math.min(Math.max(Number(new RegExp(`${k}\\s*=\\s*["']?(\\d+)`, "iu").exec(a)?.[1] ?? 1), 1), 50);
/** ponytail: 이보다 큰 표 HTML은 변환하지 않고 OCR 줄 나열로 둔다 (정규식 시간 상한) */
const MAX_TABLE_HTML = 200_000;

/** 표 HTML → 마크다운 표. 닫는 태그에 기대지 않고 시작 태그로 나눈다(빠져도 견딤).
 *  colspan은 오른쪽 빈 칸, rowspan은 첫 행에만 값·아래 행은 같은 열에 빈 칸 (열이 밀리지 않게). 변환할 행이 없으면 "" */
export function tableToMarkdown(html: string): string {
  if (html.length > MAX_TABLE_HTML) return "";
  const carry: number[] = []; // 열별로 아래 행에 남은 rowspan 수
  const rows = html.split(/<tr\b[^<>]*>/iu).slice(1).map((tr) => {
    const out: string[] = [];
    let col = 0;
    const fill = () => { while ((carry[col] ?? 0) > 0) { carry[col]!--; out.push(""); col++; } };
    for (const part of tr.split(/<t[dh]\b/iu).slice(1)) {
      const gt = part.indexOf(">");
      const attrs = gt < 0 ? "" : part.slice(0, gt);
      const body = (gt < 0 ? "" : part.slice(gt + 1)).split(/<\/t[dh]>|<\/tr>/iu)[0]!;
      fill();
      const cs = attr(attrs, "colspan"), rs = attr(attrs, "rowspan");
      for (let i = 0; i < cs; i++) { out.push(i ? "" : cellText(body)); if (rs > 1) carry[col] = rs - 1; col++; }
    }
    // 행이 rowspan 열에 닿기 전에 끝나도 그 rowspan은 이 행에서 소비 (다음 행이 밀리지 않게)
    for (; col < carry.length; col++) { if ((carry[col] ?? 0) > 0) carry[col]!--; out.push(""); }
    return out;
  }).filter((r) => r.some((c) => c));
  if (!rows.length) return "";
  const w = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${[...r, ...Array<string>(w - r.length).fill("")].join(" | ")} |`;
  return [line(rows[0]!), `| ${Array<string>(w).fill("---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}

/** OCR 페이지 그림 영역 (PP-StructureV3 image·figure·chart·seal, yoyo0704 25f42de) */
export interface OcrFigure { label: string; bbox: number[] }
// seal(직인)은 서명·시행일 줄 위에 찍히므로 본문에서 빼지 않는다 (PR #33 리뷰)
const FIGURE_LABELS = new Set(["image", "figure", "chart"]);
/** 그림 하나가 쪽 면적의 이 비율을 넘거나 쪽 줄의 절반 넘게 가져가면 분리하지 않는다 (쪽 전체 스캔을 그림으로 오인해 본문이 통째로 빠지는 것 방지) */
const FIGURE_MAX_AREA = 0.6;
/** 쪽 전체 스캔 판정 때 "본문 줄"로 세는 레이아웃 label (header·footer·number·footnote 등은 제외) */
const BODY_LABELS = new Set(["text", "paragraph_title", "doc_title", "abstract", "content", "reference"]);
// ponytail: 스캔 글자와 화면 캡처 글자를 가르는 신뢰도 기준 (실측 캡처 0.69~0.77, 스캔 규정 0.945~0.961). 문서가 늘면 재보정
const SCAN_CONF_MIN = 0.85;
// ponytail: 그림 하나의 글자 상한 (화면 캡처 한 장에 수백 줄이 나올 수 있음)
const FIGURE_TEXT_MAX = 1500;
const inBox = (b: number[] | undefined, f: number[]) => {
  if (b?.length !== 4 || f.length !== 4) return false;
  const x = (b[0]! + b[2]!) / 2, y = (b[1]! + b[3]!) / 2;
  return x >= f[0]! && x <= f[2]! && y >= f[1]! && y <= f[3]!;
};
/** 줄이 속한 그림 번호: 그림이면 figures 인덱스(영역이 없으면 -1), 본문이면 undefined.
 *  레이아웃 모델이 줄에 붙인 label을 먼저 따른다(text·title 등은 bbox가 겹쳐도 본문). bbox는 label이 없거나 옛 형식(paragraph)일 때만 */
export function figureOf(b: OcrBlock, figures: OcrFigure[]): number | undefined {
  const legacy = !b.label || b.label === "paragraph";
  if (!legacy && !FIGURE_LABELS.has(b.label)) return undefined;
  const i = figures.findIndex((f) => inBox(b.bbox, f.bbox));
  if (i >= 0) return i;
  return FIGURE_LABELS.has(b.label) ? -1 : undefined;
}
/** 자리 표시만 남은 본문인지 ("[그림 n]"만 있으면 글자 없음으로 본다) */
export const onlyPlaceholders = (t: string) => !t.replace(/^\[그림 \d+\]$/gmu, "").trim();

/** 쪽의 표·그림 나누기 (본문 만들기와 저신뢰 판정이 같은 기준을 쓰도록 한 곳에서, PR #33 리뷰).
 *  - 표: 변환된 표의 줄(table_id 또는 표 bbox 안)은 본문 줄에서 뺀다 (마크다운 표로 한 번만 들어감)
 *  - 그림: label이 그림(image·figure·chart)이거나, 옛 형식 줄이 그림 bbox 안이면 그림 줄
 *  - 쪽을 60% 넘게 덮는 그림 영역은, 그 밖에 본문 줄이 없으면 그림이 아니다(쪽 전체 스캔 오인 방지). 그 안의 줄은 label이 image여도 본문
 *  - bbox로만 묶인 그림이 쪽 글자 줄의 절반을 넘게 가져가면 분리하지 않는다 */
export function splitPage(blocks: OcrBlock[], tables: OcrTable[] = [], figures0: OcrFigure[] = [], size?: { width: number; height: number }) {
  const area = size ? size.width * size.height : 0;
  const big = (f: OcrFigure) => !!area && f.bbox?.length === 4 && ((f.bbox[2]! - f.bbox[0]!) * (f.bbox[3]! - f.bbox[1]!)) / area > FIGURE_MAX_AREA;
  // 쪽을 크게 덮는 그림이 실은 "쪽 전체 스캔"이면 그림이 아니라 본문 (레이아웃이 문서 사진 전체를 image로 잡는 경우).
  // 스캔으로 보는 경우: ① 그림 안에 조문 머리가 2개 이상 ② 그림 밖 본문 줄·그림 제목이 없고, 그림 안 글자가 또렷함(평균 신뢰도 ≥ 0.85).
  // 화면 캡처는 그림 안 글자 신뢰도가 낮다 (과천 매뉴얼 실측 0.69~0.77). 머리말·쪽 번호는 본문 줄로 세지 않는다 (PR #33 재리뷰)
  const bigs = figures0.filter((f) => FIGURE_LABELS.has(f.label) && big(f));
  const outside = blocks.filter((b) => BODY_LABELS.has(b.label) && !bigs.some((f) => inBox(b.bbox, f.bbox))).reduce((n, b) => n + b.text.trim().length, 0);
  const captioned = blocks.some((b) => b.label === "figure_title" && b.text.trim());
  const inside = (f: OcrFigure) => blocks.filter((b) => b.text.trim() && inBox(b.bbox, f.bbox));
  const articleHeads = (f: OcrFigure) => inside(f).filter((b) => /^제\s*\d+\s*조/u.test(b.text.trim())).length;
  const clear = (f: OcrFigure) => { const xs = inside(f); return xs.length > 0 && xs.reduce((s, b) => s + b.confidence, 0) / xs.length >= SCAN_CONF_MIN; };
  const pageWide = bigs.filter((f) => articleHeads(f) >= 2 || (outside < 4 && !captioned && clear(f)));
  const figures = figures0.filter((f) => FIGURE_LABELS.has(f.label) && !pageWide.includes(f));
  const md = new Map(tables.map((t) => [t.table_id, tableToMarkdown(t.html)] as const));
  const ids = new Set([...md].filter(([, v]) => v).map(([k]) => k));
  const inTable = (b: OcrBlock) => (!!b.table_id && ids.has(b.table_id)) || tables.some((t) => ids.has(t.table_id) && inBox(b.bbox, t.bbox ?? []));
  const fig = new Map<OcrBlock, number>();
  for (const b of blocks) {
    if (inTable(b) || pageWide.some((f) => inBox(b.bbox, f.bbox))) continue;
    const f = figureOf(b, figures);
    if (f !== undefined) fig.set(b, f);
  }
  const textLines = blocks.filter((b) => b.text.trim()).length;
  const undone = new Set<number>(); // 본문으로 되돌린 그림 (자리 표시·figure_boxes에서도 뺀다, PR #39 리뷰)
  for (const g of new Set(fig.values())) {
    const members = [...fig].filter(([, i]) => i === g).map(([b]) => b);
    const bboxOnly = members.every((b) => !FIGURE_LABELS.has(b.label));
    if (bboxOnly && textLines >= 4 && members.filter((b) => b.text.trim()).length > textLines / 2) { for (const b of members) fig.delete(b); undone.add(g); }
  }
  return { figures, fig, md, ids, inTable, undone };
}

/** OCR 블록 → 본문.
 *  - 표: 표 영역 줄은 빼고 그 자리에 마크다운 표 한 번(앞뒤 빈 줄). 변환 결과가 빈 표는 줄 나열 (글자 보존)
 *  - 그림(화면 캡처 등): 그림 속 줄은 본문 흐름에서 빼고 그 자리에 "[그림 n]"만. 그림 속 글자는 쪽 끝에
 *    "⟦그림 p{쪽}⟧ 그림 n 속 글자: …" 한 줄로 (사용자 지적 11/17: 캡처 속 UI 글자가 깨진 채 본문에 섞여 읽을 수 없음).
 *    이 줄은 PiiScan이 함께 가리고, 색인에서는 인용 불가 그림 청크로만 검색된다 (kb-chunker FIGURE_RE) */
export function ocrPageText(blocks: OcrBlock[], tables: OcrTable[] = [], figures0: OcrFigure[] = [], page = 0, size?: { width: number; height: number }): string {
  const { figures, fig, md, ids, inTable, undone } = splitPage(blocks, tables, figures0, size);
  const hasBox = blocks.every((b) => b.bbox?.length === 4);
  if (!ids.size && !fig.size && !figures.length) return (hasBox ? ocrRows(blocks) : blocks.map((b) => b.text)).join("\n");
  const plain = blocks.filter((b) => !inTable(b) && !fig.has(b));
  // 위치: bbox가 다 있으면 세로 위치, 아니면 원래 순서(표·그림은 그 첫 줄 자리, 줄이 없으면 맨 끝)
  const rows = hasBox ? ocrRowsY(plain) : blocks.flatMap((b, i) => (plain.includes(b) ? [{ yc: i, text: b.text }] : []));
  const END = Number.MAX_SAFE_INTEGER;
  const firstY = (pick: (b: OcrBlock) => boolean, box: number[] | undefined, k: number) => {
    const first = blocks.findIndex(pick);
    const fb = blocks[first]?.bbox;
    return hasBox ? (box?.length === 4 ? box[1]! : fb?.length === 4 ? (fb[1]! + fb[3]!) / 2 : END - 100 + k) : first >= 0 ? first - 0.5 : END - 100 + k;
  };
  const tabs = [...ids].map((id, k) => ({ yc: firstY((b) => b.table_id === id, tables.find((x) => x.table_id === id)!.bbox, k), text: `\n${md.get(id)!}\n` }));
  // 그림: 영역 순서대로 번호, 영역 없는 그림 라벨 줄은 마지막 한 묶음
  const groups = [...figures.map((f, i) => ({ i, box: f.bbox })).filter((g) => !undone.has(g.i)), ...([...fig.values()].includes(-1) ? [{ i: -1, box: undefined as number[] | undefined }] : [])];
  const figRows: { yc: number; text: string }[] = [];
  const figLines: string[] = [];
  groups.forEach((g, k) => {
    const n = k + 1;
    figRows.push({ yc: firstY((b) => fig.get(b) === g.i, g.box, 50 + k), text: `[그림 ${n}]` });
    const inner = blocks.filter((b) => fig.get(b) === g.i);
    const t = (inner.every((b) => b.bbox?.length === 4) ? ocrRows(inner) : inner.map((b) => b.text)).join(" ").replace(/\s+/gu, " ").trim();
    // 자를 때는 낱말 경계에서 (주민등록번호 등이 반만 남아 가림 규칙을 피하지 않게)
    if (t) figLines.push(`⟦그림 p${page}⟧ 그림 ${n} 속 글자: ${t.length > FIGURE_TEXT_MAX ? `${t.slice(0, FIGURE_TEXT_MAX).replace(/\S*$/u, "").trimEnd()}…` : t}`);
  });
  const body = [...rows, ...tabs, ...figRows].sort((a, b) => a.yc - b.yc).map((r) => r.text).join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  // 본문 줄이 "⟦"로 시작하면 "["로 (그림 줄 위조 방지). 진짜 그림 줄은 그 뒤에 붙임
  return [body.split("\n").map(defangFigureLine).join("\n"), ...figLines].filter(Boolean).join("\n");
}

/** 그림 상자 → 쪽 대비 0~1000 정수 [x0,y0,x1,y1]. 값이 숫자가 아니거나 쪽 크기를 모르거나 면적이 0이면 null.
 *  좌우·위아래가 뒤집혀 있으면 정렬하고, 자를 때 가장자리가 잘리지 않게 시작은 내림·끝은 올림 (PR #39 리뷰) */
export function normBox(b: number[] | undefined, w: number, h: number): number[] | null {
  if (b?.length !== 4 || !(w > 0) || !(h > 0) || !b.every(Number.isFinite)) return null;
  const c = (v: number, d: number, f: (x: number) => number) => Math.min(1000, Math.max(0, f((v / d) * 1000)));
  const [x0, x1] = [Math.min(b[0]!, b[2]!), Math.max(b[0]!, b[2]!)], [y0, y1] = [Math.min(b[1]!, b[3]!), Math.max(b[1]!, b[3]!)];
  const r = [c(x0, w, Math.floor), c(y0, h, Math.floor), c(x1, w, Math.ceil), c(y1, h, Math.ceil)];
  return r[2]! > r[0]! && r[3]! > r[1]! ? r : null;
}

export interface Segment {
  doc_id: string; page_index: number; source: "text_layer" | "ocr";
  text: string; blocks: Partial<OcrBlock>[]; avg_confidence: number | null; low_confidence: boolean;
  /** 그림 영역 [x0,y0,x1,y1] (쪽 너비·높이 대비 0~1000 정수). ImageDescribe가 그림을 정확히 잘라 보여 줄 때 씀 (yoyo0704 b782529). 그림 없으면 생략 */
  figure_boxes?: number[][];
}

// ponytail: 저신뢰 기준 고정값 (docs/04 2.1), 실측 후 조정
export const BLOCK_MIN = 0.85;
export const PAGE_AVG_MIN = 0.9;

export function buildSegments(layer: TextLayer, ocr: OcrResult | null): Segment[] {
  // 항 번호 보정 문맥은 쪽 사이에 "마지막 항 번호"만 이어 감. 조 번호는 쪽마다 새로 (잘못 읽힌 조 번호가 다음 쪽으로 번지지 않게, PR #28 리뷰)
  let lastPara = 0;
  // 3a와 PageRender가 서로 다른 PDF를 봤으면 남는 쪽이 조용히 버려진다 → 멈춘다
  if (ocr && ocr.page_count !== layer.page_count) throw new Error(`쪽 수 불일치: text_layer ${layer.page_count}, ocr ${ocr.page_count}`);
  return layer.pages.map((p) => {
    if (!p.needs_ocr) {
      lastPara = 0; // 글자 그대로 쓴 쪽을 지나면 이어 갈 문맥이 없음
      const lines = p.text.split(/\r?\n/u).filter((l) => l.trim());
      return {
        doc_id: layer.doc_id, page_index: p.page_index, source: "text_layer", text: p.text.split("\n").map(defangFigureLine).join("\n"),
        blocks: lines.map((text, i) => ({ block_id: `p${p.page_index}-l${i}`, label: "paragraph", text, reading_order: i })),
        avg_confidence: null, low_confidence: false,
      } satisfies Segment;
    }
    const op = ocr?.pages.find((x) => x.page_index === p.page_index);
    if (!op) throw new Error(`OCR 결과에 page ${p.page_index} 없음`); // 빈 결과로 성공 처리 금지
    const blocks = [...op.blocks].sort((a, b) => a.reading_order - b.reading_order);
    // 저신뢰 판정은 본문 줄만 (그림 속 글자는 화면 캡처라 원래 신뢰도가 낮음, 11/17 실측 평균 0.74)
    const figs = op.figures ?? [];
    const size = { width: op.width, height: op.height };
    // 본문 줄만(그림 줄은 본문 만들기와 같은 기준으로 제외). 글자가 빈 덩어리(신뢰도 0, 11/17 실측)도 뺀다
    const { fig, figures: kept, undone } = splitPage(blocks, op.tables, figs, size);
    // 그림으로 분리한 영역만 (쪽 전체 스캔으로 본 큰 상자·직인·본문으로 되돌린 상자는 제외)
    const boxes = kept.flatMap((f, i) => { if (undone.has(i)) return []; const b = normBox(f.bbox, op.width, op.height); return b ? [b] : []; });
    const conf = blocks.filter((b) => b.text.trim() && !fig.has(b));
    const avg = conf.length ? conf.reduce((s, b) => s + b.confidence, 0) / conf.length : 0;
    return {
      // 같은 높이 블록을 한 줄로 묶고, 숫자로 읽힌 항 번호(①→1)를 순서 근거가 있을 때만 되돌린다 (13항 12번 실측)
      doc_id: layer.doc_id, page_index: p.page_index, source: "ocr",
      text: (() => { const st = { last: lastPara, lastArticle: 0 }; const t = restoreCircled(ocrPageText(blocks, op.tables, figs, p.page_index, size), st); lastPara = st.last; return t; })(),
      blocks, avg_confidence: conf.length ? avg : null, low_confidence: !blocks.length || (conf.length > 0 && (avg < PAGE_AVG_MIN || conf.some((b) => b.confidence < BLOCK_MIN)))
        // 쪽 글자가 모두 그림 속 글자로 분류된 쪽: 흐린 스캔을 캡처로 오인했을 수 있어 사람 확인 (PR #33 재리뷰 MEDIUM-F)
        || (conf.length === 0 && [...fig.keys()].some((b) => b.text.trim())),
      ...(boxes.length ? { figure_boxes: boxes } : {}),
    } satisfies Segment;
  });
}

export async function segmentStep(input: StepInput, store: ObjectStore): Promise<StepOutput> {
  const work = `${input.doc_id}/work`;
  const layer = JSON.parse((await store.get(input.bucket, `${work}/text_layer.json`)).toString()) as TextLayer;
  const ocr = layer.pages.some((p) => p.needs_ocr)
    ? (JSON.parse((await store.get(input.bucket, `${work}/ocr/result.json`)).toString()) as OcrResult)
    : null;
  const segments = buildSegments(layer, ocr);
  // 글자가 하나도 없음 (강아지 사진 같은 그림·사진만 있는 파일, 11/17 실측): 예외로 멈추지 않고 이유를 알려 주며 차단
  if (segments.every((s) => onlyPlaceholders(s.text))) {
    const msg = segments.length === 1 ? "올린 파일에서 글자를 찾지 못했습니다. 글자 없이 사진·그림만 있는 파일은 위키에 등록할 수 없습니다."
      : `올린 파일의 ${segments.length}쪽 모두에서 글자를 찾지 못했습니다. 글자 없이 사진·그림만 있는 파일은 위키에 등록할 수 없습니다.`;
    return { status: "BLOCKED", findings: [{
      finding_id: newId("fnd"), step: "SegmentBuild", severity: "HIGH", code: "NO_TEXT", message: msg, evidence_ref: `${work}/segments/`,
      location: { page: 1 }, user_message: msg,
      fix_hint: "업무 내용이 글자로 적힌 문서(PDF·DOCX·HWPX)나 문서를 찍은 사진을 올려 주세요. 사진이라면 글자가 잘 보이게 반듯하게 다시 찍어 주세요.",
    }] };
  }
  for (const s of segments) {
    await store.put(input.bucket, `${work}/segments/${String(s.page_index).padStart(4, "0")}.json`, JSON.stringify(s));
  }
  // OCR 저신뢰 경고는 내지 않는다 (사용자 결정 11/18 17시: 95% 미만 쪽은 ImageDescribe가 Vision으로 다시 읽음). 세그먼트의 avg_confidence·low_confidence는 그대로 남김
  const findings: Finding[] = structureFindings(segments, work);
  const review = findings.some((f) => f.severity !== "LOW");
  return { status: review ? "REVIEW_REQUIRED" : "OK", output_key: `${work}/segments/`, findings };
}

/** 조문형 문서(제N조 머리 3개 이상)의 구조 이상을 쪽·문장 위치로 안내. 부칙(타법개정 인용이 많음)은 제외, 최대 5건.
 *  이 단계는 PII 마스킹 전이라 excerpt는 반드시 @hanaeum/pii로 가린 뒤 담는다 */
export function structureFindings(segments: Pick<Segment, "page_index" | "text">[], work: string): Finding[] {
  const lines: { page: number; text: string }[] = segments.flatMap((s) => s.text.split("\n").map((t) => ({ page: s.page_index + 1, text: t })));
  if (lines.filter((l) => /^제\s*\d+\s*조/u.test(l.text.trim())).length < 3) return [];
  const suppAt = lines.findIndex((l) => /^부\s*칙/u.test(l.text.trim()));
  const law = parseLaw(lines.map((l) => l.text).join("\n"), { law_id: "CHECK", law_name: "check", revision_id: "2000-01-01" });
  return law.issues
    .filter((i) => i.line && (suppAt < 0 || i.line - 1 < suppAt))
    .slice(0, 5)
    .map((i) => {
      const at = lines[i.line! - 1]!;
      const excerpt = maskText(at.text.trim()).slice(0, 120);
      const msg = i.code === "NUMBER_REGRESSION"
        ? `${at.page}쪽 "${excerpt.slice(0, 40)}" 부근: 조·항·호 번호 순서가 맞지 않습니다(${i.message.split(":")[0]}). 조문이 빠졌거나 번호가 잘못 붙었을 수 있습니다.`
        : `${at.page}쪽 "${excerpt.slice(0, 40)}" 부근: ${ISSUE_TEXT[i.code] ?? "조문 구조를 해석하지 못했습니다"}.`;
      return {
        finding_id: newId("fnd"), step: "SegmentBuild", severity: "MEDIUM" as const, code: i.code === "NUMBER_REGRESSION" ? "STRUCTURE_NUMBERING" : `STRUCTURE_${i.code}`, message: msg,
        evidence_ref: `${work}/segments/`, location: { page: at.page, excerpt }, user_message: msg,
        fix_hint: "원본에서 해당 쪽의 조·항·호 번호를 확인해 고친 뒤 다시 올려 주세요. 의도된 번호라면 검토자에게 사유를 남겨 주세요.",
      };
    });
}
const maskText = (t: string) => { const sp = detectPii(t); return sp.length ? mask(t, sp) : t; };
