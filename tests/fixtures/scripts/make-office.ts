// 데모·테스트용 DOCX·HWPX 생성 (업로드 허용 형식, 13항 9번). 합성 문서 txt를 문단으로 넣고 중간에 쪽 나눔 1개.
// 실행: node tests/fixtures/scripts/make-office.ts F-001 [...]  → tests/fixtures/documents/office/{id}.docx|.hwpx
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { zipSync, strToU8 } from "fflate";

const ROOT = new URL("../", import.meta.url);
const OUT = new URL("documents/office/", ROOT);
const esc = (s: string) => s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
const FIXED = new Date("2026-11-16T00:00:00Z"); // 바이트 고정 (해시 재현)

export function docx(lines: string[], breakAt: number): Uint8Array {
  const p = (t: string, i: number) => `${i === breakAt ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : ""}<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines.map(p).join("")}</w:body></w:document>`),
  }, { mtime: FIXED });
}

export function hwpx(lines: string[], breakAt: number): Uint8Array {
  const p = (t: string, i: number) => `<hp:p id="${i}" paraPrIDRef="0" styleIDRef="0" pageBreak="${i === breakAt ? 1 : 0}" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${esc(t)}</hp:t></hp:run></hp:p>`;
  return zipSync({
    mimetype: [strToU8("application/hwp+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8('<?xml version="1.0" encoding="UTF-8"?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></ocf:rootfiles></ocf:container>'),
    "Contents/content.hpf": strToU8('<?xml version="1.0" encoding="UTF-8"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="section0"/></opf:spine></opf:package>'),
    "Contents/section0.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">${lines.map(p).join("")}</hs:sec>`),
  }, { mtime: FIXED });
}

if (import.meta.main) {
  mkdirSync(OUT, { recursive: true });
  for (const id of process.argv.slice(2)) {
    const lines = readFileSync(new URL(`documents/${id}.txt`, ROOT), "utf8").split("\n").filter((l) => l.trim());
    const at = Math.floor(lines.length / 2);
    writeFileSync(new URL(`${id}.docx`, OUT), docx(lines, at));
    writeFileSync(new URL(`${id}.hwpx`, OUT), hwpx(lines, at));
    console.log(id, "docx·hwpx", lines.length, "문단, 쪽 나눔", at);
  }
}
