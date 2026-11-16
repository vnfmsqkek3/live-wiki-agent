// 단계 5 SegmentBuild: text_layer + OCR 결과를 페이지별 세그먼트로 병합 (docs/04 1.1, 2.1)
import { ocrRows, restoreCircled } from "@hanaeum/legal-parser";
import { newId } from "@hanaeum/schemas";
import type { Finding, StepInput, StepOutput } from "@hanaeum/schemas";
import type { ObjectStore } from "./store.ts";
import type { TextLayer } from "./text-layer.ts";

export interface OcrBlock { block_id: string; label: string; text: string; confidence: number; bbox: number[]; reading_order: number; table_id: string | null }
export interface OcrResult { doc_id: string; model: string; model_version: string; page_count: number; pages: { page_index: number; width: number; height: number; source: string; blocks: OcrBlock[] }[] }

export interface Segment {
  doc_id: string; page_index: number; source: "text_layer" | "ocr";
  text: string; blocks: Partial<OcrBlock>[]; avg_confidence: number | null; low_confidence: boolean;
}

// ponytail: 저신뢰 기준 고정값 (docs/04 2.1), 실측 후 조정
export const BLOCK_MIN = 0.85;
export const PAGE_AVG_MIN = 0.9;

export function buildSegments(layer: TextLayer, ocr: OcrResult | null): Segment[] {
  return layer.pages.map((p) => {
    if (!p.needs_ocr) {
      const lines = p.text.split(/\r?\n/u).filter((l) => l.trim());
      return {
        doc_id: layer.doc_id, page_index: p.page_index, source: "text_layer", text: p.text,
        blocks: lines.map((text, i) => ({ block_id: `p${p.page_index}-l${i}`, label: "paragraph", text, reading_order: i })),
        avg_confidence: null, low_confidence: false,
      } satisfies Segment;
    }
    const op = ocr?.pages.find((x) => x.page_index === p.page_index);
    if (!op) throw new Error(`OCR 결과에 page ${p.page_index} 없음`); // 빈 결과로 성공 처리 금지
    const blocks = [...op.blocks].sort((a, b) => a.reading_order - b.reading_order);
    const avg = blocks.length ? blocks.reduce((s, b) => s + b.confidence, 0) / blocks.length : 0;
    return {
      // 같은 높이 블록을 한 줄로 묶고, 숫자로 읽힌 항 번호(①→1)를 순서 근거가 있을 때만 되돌린다 (13항 12번 실측)
      doc_id: layer.doc_id, page_index: p.page_index, source: "ocr",
      text: restoreCircled((blocks.every((b) => b.bbox?.length === 4) ? ocrRows(blocks) : blocks.map((b) => b.text)).join("\n")),
      blocks, avg_confidence: avg, low_confidence: !blocks.length || avg < PAGE_AVG_MIN || blocks.some((b) => b.confidence < BLOCK_MIN),
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
  if (segments.every((s) => !s.text.trim())) throw new Error("모든 페이지 텍스트가 비어 있음");
  for (const s of segments) {
    await store.put(input.bucket, `${work}/segments/${String(s.page_index).padStart(4, "0")}.json`, JSON.stringify(s));
  }
  const low = segments.filter((s) => s.low_confidence);
  const findings: Finding[] = low.map((s) => ({
    finding_id: newId("fnd"), step: "SegmentBuild", severity: "MEDIUM", code: "LOW_OCR_CONFIDENCE",
    message: `page ${s.page_index} OCR 평균 신뢰도 ${s.avg_confidence?.toFixed(3)}`, evidence_ref: `${work}/segments/${String(s.page_index).padStart(4, "0")}.json`,
  }));
  return { status: low.length ? "REVIEW_REQUIRED" : "OK", output_key: `${work}/segments/`, findings };
}
