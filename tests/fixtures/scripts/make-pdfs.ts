// 데모 업로드용 PDF 생성 (업로드 허용 형식이 PDF·DOCX·HWPX·PNG/JPG — dhxorb96 요청 1734 회신 5번).
// 텍스트 레이어가 있는 PDF를 Chrome headless로 만든다 (OCR 불필요). 폰트는 Noto Sans KR(OFL).
// PDF 바이트는 생성 시각이 들어가 매번 달라지므로, 한 번 만들어 커밋하고 Registry에는 그 PDF의 해시를 기록한다.
// 실행: node tests/fixtures/scripts/make-pdfs.ts  (Chrome 필요, 네트워크로 웹폰트 로드)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const OUT = new URL("documents/pdf/", ROOT);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const PDF_DOCS = ["F-000", "F-001", "F-002", "F-003", "K-001", "K-002", "K-003", "K-004", "A-001"];
const src = (id: string) => (id.startsWith("F-") ? `documents/${id}.txt` : `documents/${id}.md`);
const esc = (s: string) => s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

if (import.meta.main) {
  mkdirSync(OUT, { recursive: true });
  const tmp = fileURLToPath(new URL("documents/pdf/.tmp.html", ROOT));
  const hashes: Record<string, string> = {};
  for (const id of PDF_DOCS) {
    // front matter(cites 등 정답 메타데이터)는 문서 본문이 아니므로 제외. 줄 구조 보존 (pre-wrap, 넓은 용지로 줄바꿈 최소화)
    const body = readFileSync(new URL(src(id), ROOT), "utf8").replace(/^---\n[\s\S]*?\n---\n/u, "");
    writeFileSync(tmp, `<!doctype html><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400&display=block" rel="stylesheet">
<style>@page{size:420mm 297mm;margin:12mm} body{font-family:'Noto Sans KR',sans-serif;font-size:10pt;line-height:1.5;white-space:pre-wrap;margin:0}</style>
<body>${esc(body)}</body>`);
    const out = fileURLToPath(new URL(`${id}.pdf`, OUT));
    execFileSync(CHROME, ["--headless", "--disable-gpu", "--no-pdf-header-footer", "--virtual-time-budget=10000", `--print-to-pdf=${out}`, `file://${tmp}`], { stdio: "ignore" });
    hashes[id] = "sha256:" + createHash("sha256").update(readFileSync(out)).digest("hex");
    console.log(id, hashes[id]);
  }
  execFileSync("rm", ["-f", tmp]);
  writeFileSync(new URL("hashes.json", OUT), JSON.stringify(hashes, null, 2) + "\n");
}
