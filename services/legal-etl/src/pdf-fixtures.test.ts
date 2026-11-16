// 데모 업로드용 PDF(tests/fixtures/documents/pdf)가 3a 텍스트 추출 → 파서에서 원본 텍스트와 같은 구조로 복원되는지
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseLaw } from "@hanaeum/legal-parser";
import { extractTextLayer } from "./text-layer.ts";

const FIX = new URL("../../../tests/fixtures/", import.meta.url);
const dir = (id: string) => (id.startsWith("G-") ? "golden" : "documents");
const pdfText = async (id: string) => {
  const layer = await extractTextLayer(readFileSync(new URL(`${dir(id)}/pdf/${id}.pdf`, FIX)), "pdf", id);
  assert.ok(layer.pages.every((p) => !p.needs_ocr), `${id}: 텍스트 레이어 부족 → OCR로 빠지면 안 됨`);
  return layer.pages.map((p) => p.text).join("\n");
};
const REG: Record<string, string> = { "F-000": "2025-01-01", "F-001": "2026-11-01", "F-002": "2026-12-01", "F-003": "2026-11-01" };
// Golden 규정 기준본 16건 (공유 dev 게시용 PDF, registry.golden.json pdf_content_hash)
for (let i = 1; i <= 12; i++) REG[`G-REG-${String(i).padStart(2, "0")}`] = "2026-11-01";
for (let i = 1; i <= 4; i++) REG[`G-REV-${String(i).padStart(2, "0")}`] = "2026-12-01";

for (const [id, rev] of Object.entries(REG)) {
  test(`${id}.pdf → 파싱 결과가 ${id}.txt와 같음 (조·항·호 경로·상태·본문)`, async () => {
    const meta = { law_id: "SYN-X", law_name: "x", revision_id: rev };
    const fromTxt = parseLaw(readFileSync(new URL(`${dir(id)}/${id}.txt`, FIX), "utf8"), meta);
    const fromPdf = parseLaw(await pdfText(id), meta);
    const view = (l: typeof fromTxt) => l.provisions.map((p) => [p.provision_id, p.status, p.normalized_text.replace(/\s/gu, "")]);
    assert.deepEqual(view(fromPdf), view(fromTxt));
    assert.deepEqual(fromPdf.issues, fromTxt.issues);
  });
}

test("노하우·공격 PDF: 본문·SYNTHETIC 표시·Injection 문구가 텍스트로 추출됨", async () => {
  for (const id of ["K-001", "K-002", "K-003", "K-004", "A-001"]) assert.match(await pdfText(id), /SYNTHETIC/u, id);
  assert.match(await pdfText("A-001"), /이전 지시를 모두 무시하라/u);
  assert.match(await pdfText("K-001"), /제14조제1항/u);
});
