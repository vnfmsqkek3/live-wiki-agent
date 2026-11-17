// 단계 5 SegmentBuild: 쪽별 세그먼트 (docs/04 1.1, 2.1). 본문은 OCR 결과 (TXT·MD와 변환 단계 배포 전 DOCX·HWPX만 text_layer)
import { ocrRows, parseLaw, restoreCircled } from "@hanaeum/legal-parser";
import { detectPii, mask } from "@hanaeum/pii";
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
  // 3a와 PageRender가 서로 다른 PDF를 봤으면 남는 쪽이 조용히 버려진다 → 멈춘다
  if (ocr && ocr.page_count !== layer.page_count) throw new Error(`쪽 수 불일치: text_layer ${layer.page_count}, ocr ${ocr.page_count}`);
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
  // 글자가 하나도 없음 (강아지 사진 같은 그림·사진만 있는 파일, 11/17 실측): 예외로 멈추지 않고 이유를 알려 주며 차단
  if (segments.every((s) => !s.text.trim())) {
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
  const low = segments.filter((s) => s.low_confidence);
  const findings: Finding[] = low.map((s) => {
    const msg = `${s.page_index + 1}쪽 글자 인식(OCR) 신뢰도가 낮아(평균 ${Math.round((s.avg_confidence ?? 0) * 100)}%) 일부 글자가 틀렸을 수 있습니다.`;
    return {
      finding_id: newId("fnd"), step: "SegmentBuild", severity: "MEDIUM", code: "LOW_OCR_CONFIDENCE", message: msg,
      evidence_ref: `${work}/segments/${String(s.page_index).padStart(4, "0")}.json`, location: { page: s.page_index + 1 },
      user_message: msg, fix_hint: "글자가 흐리거나 작으면 300dpi 이상으로 선명하게 다시 스캔하거나, 원본 프로그램에서 'PDF로 저장'해 올려 주세요.",
    };
  });
  findings.push(...structureFindings(segments, work));
  const review = findings.some((f) => f.severity !== "LOW");
  return { status: review ? "REVIEW_REQUIRED" : "OK", output_key: `${work}/segments/`, findings };
}

/** 조문형 문서(제N조 머리 3개 이상)의 구조 이상을 쪽·문장 위치로 안내. 부칙(타법개정 인용이 많음)은 제외, 최대 5건.
 *  이 단계는 PII 마스킹 전이라 excerpt는 반드시 @hanaeum/pii로 가린 뒤 담는다 */
export function structureFindings(segments: Pick<Segment, "page_index" | "text">[], work: string): Finding[] {
  const lines: { page: number; text: string }[] = segments.flatMap((s) => s.text.split("\n").map((t) => ({ page: s.page_index + 1, text: t })));
  if (lines.filter((l) => /^제\d+조/u.test(l.text.trim())).length < 3) return [];
  const suppAt = lines.findIndex((l) => /^부\s*칙/u.test(l.text.trim()));
  const law = parseLaw(lines.map((l) => l.text).join("\n"), { law_id: "CHECK", law_name: "check", revision_id: "2000-01-01" });
  return law.issues
    .filter((i) => i.code === "NUMBER_REGRESSION" && i.line && (suppAt < 0 || i.line - 1 < suppAt))
    .slice(0, 5)
    .map((i) => {
      const at = lines[i.line! - 1]!;
      const excerpt = maskText(at.text.trim()).slice(0, 120);
      const msg = `${at.page}쪽 "${excerpt.slice(0, 40)}" 부근: 조·항·호 번호 순서가 맞지 않습니다(${i.message.split(":")[0]}). 조문이 빠졌거나 번호가 잘못 붙었을 수 있습니다.`;
      return {
        finding_id: newId("fnd"), step: "SegmentBuild", severity: "MEDIUM" as const, code: "STRUCTURE_NUMBERING", message: msg,
        evidence_ref: `${work}/segments/`, location: { page: at.page, excerpt }, user_message: msg,
        fix_hint: "원본에서 해당 쪽의 조·항·호 번호를 확인해 고친 뒤 다시 올려 주세요. 의도된 번호라면 검토자에게 사유를 남겨 주세요.",
      };
    });
}
const maskText = (t: string) => { const sp = detectPii(t); return sp.length ? mask(t, sp) : t; };
