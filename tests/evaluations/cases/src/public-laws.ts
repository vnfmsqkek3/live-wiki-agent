// 공개 법령으로 파서 일반화 검증 (합성 데이터 밖).
// 입력: legalize-kr(국가법령정보센터 원문 → Markdown) 파일. 자료/데이터원천/법령/ (공개 자료라 Git에 포함).
// 정답: Markdown 마크업(##### 조, **①** 항, 2칸 들여쓰기 "N\." 호, 4칸 "가\." 목)에서 독립적으로 추출 — 공식 XML 구조에서 생성된 마크업이다.
// 파서 입력: 마크업을 모두 지운 평문 (국가법령정보센터 조문 복사 형태: "제2조(정의) ① 이 법에서 …").
// 범위: 본칙만. 부칙은 마크업이 없어 정답을 만들 수 없음.
// 실행: node tests/evaluations/cases/src/public-laws.ts
import { readdirSync, readFileSync } from "node:fs";
import { parseLaw } from "@hanaeum/legal-parser";
import { SUBITEM_CODES } from "@hanaeum/schemas";
import type { SubitemChar } from "@hanaeum/schemas";

const DIR = new URL("../../../../자료/데이터원천/법령/", import.meta.url);
const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";

/** front matter 분리 + 본칙/부칙 분리 */
function split(md: string) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/u)!;
  const meta = Object.fromEntries(m[1]!.split("\n").map((l) => l.match(/^(\S+):\s*'?(.*?)'?$/u)).filter(Boolean).map((x) => [x![1], x![2]]));
  const body = m[2]!;
  const i = body.search(/^## 부칙\s*$/mu);
  return { meta, main: i < 0 ? body : body.slice(0, i), supp: i < 0 ? "" : body.slice(i) };
}

const head = (s: string) => s.replace(/<[^>]*>|\[[^\]]*\]/gu, "").replace(/\\\./gu, ".").replace(/[\s\u318D\u00B7]/gu, "").slice(0, 20);
/** 정답 본문 첫 20자 (태그·공백 제거). 조는 항이 없을 때만 */
export const expectedText = new Map<string, string>();

/** 정답: 마크업 기반 독립 추출 [경로, 상태] */
export function expectedFromMarkup(main: string): [string, string][] {
  expectedText.clear();
  const out: [string, string][] = [];
  const lines = main.split("\n");
  let art = "", para = "", item = "";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^##### 제(\d+)조(?:의(\d+))?/u))) {
      art = `ARTICLE:${m[1]}${m[2] ? `-${m[2]}` : ""}`; para = ""; item = "";
      const next = lines.slice(i + 1).find((x) => x.trim()) ?? "";
      out.push([art, /^삭제/u.test(next.trim()) ? "DELETED" : "ACTIVE"]);
      if (!/^\*\*|^ {2}\d/u.test(next)) expectedText.set(art, head(next));
    } else if ((m = l.match(/^\*\*(.|<\d+>)\*\*\s*(?:<\d+>\s*)?(.*)$/u)) && (CIRCLED.includes(m[1]!) || /^<\d+>$/u.test(m[1]!))) {
      const n = CIRCLED.includes(m[1]!) ? CIRCLED.indexOf(m[1]!) + 1 : Number(m[1]!.slice(1, -1));
      para = `${art}/PARAGRAPH:${n}`; item = "";
      out.push([para, /^삭제/u.test(m[2]!) ? "DELETED" : "ACTIVE"]);
      expectedText.set(para, head(m[2]!));
    } else if ((m = l.match(/^ {2}(\d+)(?:의(\d+))?\\\.\s*(.*)$/u))) {
      item = `${para || art}/ITEM:${m[1]}${m[2] ? `-${m[2]}` : ""}`;
      out.push([item, /^삭제/u.test(m[3]!) ? "DELETED" : "ACTIVE"]);
      expectedText.set(item, head(m[3]!));
    } else if ((m = l.match(/^ {4}([가-하])\\\.\s*(.*)$/u)) && m[1]! in SUBITEM_CODES) {
      const sid = `${item}/SUBITEM:${SUBITEM_CODES[m[1] as SubitemChar]}`;
      out.push([sid, /^삭제/u.test(m[2]!) ? "DELETED" : "ACTIVE"]);
      expectedText.set(sid, head(m[2]!));
    }
  }
  return out;
}

/** 파서 입력: 마크업 제거 평문. 조 머리와 첫 본문 줄은 한 줄로 합친다 (공식 조문 형태) */
export function toPlain(main: string): string {
  const lines = main.split("\n").map((l) => l.replace(/\\\./gu, ".").replace(/^\*\*(.|<\d+>)\*\*/u, "$1").replace(/^#+\s*/u, "").trim()).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const h = l.match(/^(제\d+조(?:의\d+)?)\s*(\((?:[^()]|\([^()]*\))*\))?\s*$/u);
    if (h && i + 1 < lines.length) { out.push(`${h[1]}${h[2] ?? ""} ${lines[++i]}`); continue; }
    out.push(l);
  }
  return out.join("\n");
}

export function measurePublicLaw(md: string) {
  const { meta, main } = split(md);
  const expected = expectedFromMarkup(main);
  const law = parseLaw(toPlain(main), { law_id: `KR-${meta["법령ID"]}`, law_name: String(meta["제목"]), revision_id: String(meta["시행일자"]) });
  const B = `KR-${meta["법령ID"]}@${meta["시행일자"]}/`;
  const got = new Set(law.provisions.filter((p) => !p.provision_id.includes("SUPPLEMENTARY") && p.level !== "ANNEX").map((p) => `${p.provision_id.slice(B.length)}|${p.status}`));
  const exp = new Set(expected.map(([p, s]) => `${p}|${s}`));
  const missing = [...exp].filter((e) => !got.has(e));
  const extra = [...got].filter((g) => !exp.has(g));
  const union = new Set([...exp, ...got]).size;
  // 본문 일치: 삭제가 아닌 노드의 본문 첫 20자 (원문에서 태그 제거) 비교
  const textMismatch: string[] = [];
  for (const p of law.provisions) {
    const path = p.provision_id.slice(B.length);
    const want = expectedText.get(path);
    if (want === undefined || p.status === "DELETED") continue;
    if (head(p.original_text) !== want) textMismatch.push(`${path}: "${head(p.original_text)}" ≠ "${want}"`);
  }
  return { name: String(meta["제목"]), expected: exp.size, got: got.size, matched: exp.size - missing.length, accuracy: (exp.size - missing.length) / union, missing, extra, issues: law.issues, textChecked: [...expectedText.keys()].length, textMismatch };
}

if (import.meta.main) {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".md"));
  if (!files.length) { console.log("자료/데이터원천/법령/에 legalize-kr Markdown이 없음 (자료/README.md 색인의 URL로 받기)"); process.exit(0); }
  let m = 0, u = 0;
  console.log("| 법령 | 정답 노드 | 일치 | 누락 | 초과 | 구조 정확도 | 본문 불일치 |");
  console.log("|---|---|---|---|---|---|---|");
  const all = files.map((f) => measurePublicLaw(readFileSync(new URL(f, DIR), "utf8")));
  for (const r of all) {
    m += r.matched; u += r.matched + r.missing.length + r.extra.length;
    console.log(`| ${r.name} | ${r.expected} | ${r.matched} | ${r.missing.length} | ${r.extra.length} | ${(r.accuracy * 100).toFixed(1)}% | ${r.textMismatch.length}/${r.textChecked} |`);
  }
  console.log(`| **합계** | | ${m} | | | **${((m / u) * 100).toFixed(1)}%** |`);
  for (const r of all) {
    for (const x of r.missing.slice(0, 8)) console.log(`  ${r.name} 누락 ${x}`);
    for (const x of r.extra.slice(0, 8)) console.log(`  ${r.name} 초과 ${x}`);
    for (const x of r.textMismatch.slice(0, 5)) console.log(`  ${r.name} 본문 ${x}`);
  }
}
