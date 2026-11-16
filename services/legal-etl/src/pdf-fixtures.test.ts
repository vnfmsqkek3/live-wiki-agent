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

// 13항 9번: 업로드 허용 형식 DOCX·HWPX도 실제로 처리한다 (부풀림 금지)
for (const ext of ["docx", "hwpx"] as const) {
  for (const id of ["F-001", "F-003"]) {
    test(`${id}.${ext} → 쪽 나눔대로 2페이지, 파싱 결과가 ${id}.txt와 같음`, async () => {
      const layer = await extractTextLayer(readFileSync(new URL(`documents/office/${id}.${ext}`, FIX)), ext, id);
      assert.equal(layer.page_count, 2);
      assert.ok(layer.pages.every((p) => !p.needs_ocr && p.char_count > 50));
      const meta = { law_id: "SYN-X", law_name: "x", revision_id: "2026-11-01" };
      const view = (l: ReturnType<typeof parseLaw>) => l.provisions.map((p) => [p.provision_id, p.status, p.normalized_text.replace(/\s/gu, "")]);
      const fromTxt = parseLaw(readFileSync(new URL(`documents/${id}.txt`, FIX), "utf8"), meta);
      const fromDoc = parseLaw(layer.pages.map((p) => p.text).join("\n"), meta);
      assert.deepEqual(view(fromDoc), view(fromTxt));
    });
  }
}

test("DOCX·HWPX: 표 셀·탭·XML 엔티티·구역 나눔, 깨진 파일은 명확한 오류", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  const { docxPages, hwpxPages } = await import("./office.ts");
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const d = zipSync({ "word/document.xml": strToU8(`<w:document ${W}><w:body><w:p><w:r><w:t>제1조(목적)</w:t><w:tab/><w:t xml:space="preserve">A &amp; B &lt;C&gt;</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>셀1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>셀2</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`) });
  assert.deepEqual(docxPages(Buffer.from(d)), ["제1조(목적)\tA & B <C>\n셀1\n셀2"]);
  const H = 'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"';
  const h = zipSync({
    "Contents/section0.xml": strToU8(`<hs:sec ${H}><hp:p><hp:run><hp:t>첫 구역</hp:t></hp:run></hp:p></hs:sec>`),
    "Contents/section1.xml": strToU8(`<hs:sec ${H}><hp:p><hp:run><hp:t>둘째<hp:tab/>구역</hp:t></hp:run></hp:p></hs:sec>`),
  });
  assert.deepEqual(hwpxPages(Buffer.from(h)), ["첫 구역", "둘째\t구역"]);
  assert.throws(() => docxPages(Buffer.from(zipSync({ "x.txt": strToU8("x") }))), { name: "InvalidOfficeFile" });
});
