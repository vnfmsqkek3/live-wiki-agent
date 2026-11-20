// 한국 법령 결정적 상태 머신 파서 (docs/04 6.2, docs/01 7.4~7.9)
// 줄 머리 패턴 + 번호 연속성 검사로 계층을 복원한다. 번호가 맞지 않는 줄은 본문 이어쓰기로 보고 issue를 남긴다.
import { ParsedLaw, SUBITEM_CODES, SUBITEM_CHARS, isoFromDotted } from "@hanaeum/schemas";
import type { Provision, ProvisionLevel, SubitemChar } from "@hanaeum/schemas";
import { resolveReferences } from "./reference.ts";

export const PARSER_VERSION = "legal-parser@0.1.0";

export interface LawMeta {
  law_id: string;
  law_name: string;
  revision_id: string; // yyyy-mm-dd
  effective_from?: number;
}

/** 공백 없는 장 제목 후보가 실은 본문 문장인지: 서술 어미로 끝나거나 다른 조·장 인용이 또 나옴 */
const headingLooksLikeBody = (line: string) => /다\.?$/u.test(line) || /제\s*\d+\s*[조장절편관]/u.test(line.slice(3));

const DATE = String.raw`\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\.?`;
const RE = {
  // 관: 민법 등 절 아래 계층. 공백 있는 제목은 그대로(길이 제한 없음).
  // OCR은 "제2장심사 절차"처럼 공백을 빼먹는다(11/17 실측) → 공백 없는 제목도 받되 좁게: 바로 한글, 조사·어미로 시작하지 않음, 쉼표·가운뎃점·괄호 없음, 40자 이하.
  // 본문 줄("제2장에 따른…", "제2장중 제5조를 삭제한다.")은 headingLooksLikeBody로 한 번 더 거른다 (PR #26 리뷰)
  heading: /^제(\d+)(편|장|절|관)(?:\s+(.+)|(?=[가-힣])(?!에|의|을|를|은|는|과|와|로|중|으로|부터|까지)(?!(?:인|만|도|이|가)(?:\s|$))([^,·()]{1,40}))$/u,
  // 제목 괄호 뒤에는 공백·줄끝이 와야 한다 ("제10조(특례)에 따른 …" 같은 본문 인용 줄을 조로 오인하지 않게)
  // 제목 안의 괄호 한 단계 허용: "제50조(분사무소(分事務所) 설치의 등기)"
  // OCR은 "제 1 조(목적)"처럼 번호 앞뒤에 공백을 넣기도 한다(11/17 DOCX→PDF→OCR 실측)
  article: /^제\s*(\d+)\s*(?:-\s*(\d+)\s*조(?:\s*의\s*(\d+))?|조(?:\s*의\s*(\d+))?)(?:\s*\(((?:[^()]|\([^()]*\))*)\)(?=\s|$))?\s*(.*)$/u, // 제9-5조(행정규칙 가지번호)는 제9조의5와 같은 ARTICLE:9-5, 제2-1조의2는 ARTICLE:2-1-2 (외국환거래규정 20개, prod 11/20)
  // ①~⑳, ㉑~㉟, ㊱~㊿ 또는 "<16>" 표기 (국가법령정보센터 원문은 16항부터 <16>을 쓰기도 함)
  paragraph: /^(?:([①-⑳㉑-㉟㊱-㊿])|<(\d{1,2})>)\s*(?:<\2>\s*)?(.*)$/u,
  item: /^(\d+)(?:의(\d+))?\.\s*(.*)$/u,
  subitem: new RegExp(`^([${SUBITEM_CHARS.join("")}])\\.\\s*(.*)$`, "u"),
  supplementary: /^부\s*칙(?:\s*<([^>]+)>)?(?:\s*\([^()]*\))?\s*$/u, // 타법개정 부칙: "부칙 <법률 제5982호, 1999. 5. 24.> (정부조직법)"
  annex: /^\[(별표|별지)\s*(?:제\s*)?(\d+)(?:호)?(?:의(\d+))?(?:\s*서식)?\]\s*(.*)$/u,
  deleted: new RegExp(`^삭제\\s*<(${DATE})>`, "u"),
  amend: new RegExp(`<(개정|신설)\\s+((?:${DATE},?\\s*)+)>`, "gu"),
  moved: /<종전의\s+([^>]+?)에서\s+이동[^>]*>/gu,
  tailTag: /\[(본조신설|시행일|전문개정|제목개정)\s*:?\s*([^\]]+)\]/gu,
};

/** 동그라미 숫자 → 정수 */
export function circledToInt(ch: string): number {
  const c = ch.codePointAt(0)!;
  if (c >= 0x2460 && c <= 0x2473) return c - 0x2460 + 1;
  if (c >= 0x3251 && c <= 0x325f) return c - 0x3251 + 21;
  if (c >= 0x32b1 && c <= 0x32bf) return c - 0x32b1 + 36;
  throw new Error(`circled number 아님: ${ch}`);
}

/** NFC + 가운뎃점 통일 + 공백 정리 (원문은 별도 보존) */
export function normalizeText(s: string): string {
  return s.normalize("NFC").replace(/[ㆍ·‧・]/gu, "·").replace(/\s+/gu, " ").trim();
}

interface Ctx {
  articleNo: number; articleBranch: number; articleKey: string; articleLabel: string;
  paraNo: number; paraKey: string | null; paraLabel: string;
  itemNo: number; itemBranch: number; itemKey: string | null; itemLabel: string;
  subitemIdx: number;
}

export function parseLaw(text: string, meta: LawMeta): ParsedLaw {
  const base = `${meta.law_id}@${meta.revision_id}`;
  const provisions: Provision[] = [];
  const issues: ParsedLaw["issues"] = [];
  const headings: { PART?: string; CHAPTER?: string; SECTION?: string; SUBSECTION?: string } = {};
  const siblingCount = new Map<string | null, number>();
  let ns = ""; // "" = 본칙, "SUPPLEMENTARY:k/" = 부칙
  let suppCount = 0;
  let ctx: Ctx | null = null;
  let current: Provision | null = null;
  const seen = new Set<string>();

  const push = (level: ProvisionLevel, id: string, parent: string | null, marker: string, body: string, line: number, pathLabel: string, title?: string) => {
    if (seen.has(id)) issues.push({ code: "DUPLICATE_ID", line, message: id });
    seen.add(id);
    const order = siblingCount.get(parent) ?? 0;
    siblingCount.set(parent, order + 1);
    const p: Provision = {
      provision_id: id, level, original_marker: marker, title,
      original_text: body, normalized_text: "", parent_id: parent, sibling_order: order,
      status: "ACTIVE", amendments: [], tail_tags: {}, references: [], path_label: pathLabel,
      heading_path: [headings.PART, headings.CHAPTER, headings.SECTION, headings.SUBSECTION].filter((h): h is string => !!h),
      source_line: line,
    };
    provisions.push(p);
    current = p;
  };

  // 조 머리 줄의 "① …"처럼 한 줄에 붙은 하위 계층은 같은 줄 번호로 다시 넣는다
  const queue = text.split(/\r?\n/u).map((raw, i) => ({ raw, ln: i + 1 }));
  while (queue.length) {
    const { raw, ln } = queue.shift()!;
    const line = raw.normalize("NFC").trim();
    // 원문 glyph 보존 (docs/01 7.6): 정규식은 NFC 줄로 맞추고, 저장은 원문 줄에서 같은 위치를 잘라 쓴다.
    // NFC가 길이를 바꾸면(조합형 한글 등) 원문 위치를 알 수 없으므로 NFC 값을 쓴다.
    const rawLine = raw.trim();
    const rawOf = (suffix: string) => (rawLine.length === line.length ? rawLine.slice(line.length - suffix.length) : suffix);
    if (!line) continue;
    let m: RegExpMatchArray | null;

    if ((m = line.match(RE.supplementary))) {
      suppCount++;
      ns = `SUPPLEMENTARY:${suppCount}/`;
      ctx = null;
      push("SUPPLEMENTARY", `${base}/SUPPLEMENTARY:${suppCount}`, null, "부칙", line, ln, "부칙", m[1]);
      continue;
    }
    if ((m = line.match(RE.heading)) && !(m[3] === undefined && headingLooksLikeBody(line))) {
      const lvl = ({ 편: "PART", 장: "CHAPTER", 절: "SECTION", 관: "SUBSECTION" } as const)[m[2] as "편" | "장" | "절" | "관"];
      headings[lvl] = line;
      if (lvl === "PART") { headings.CHAPTER = undefined; headings.SECTION = undefined; headings.SUBSECTION = undefined; }
      if (lvl === "CHAPTER") { headings.SECTION = undefined; headings.SUBSECTION = undefined; }
      if (lvl === "SECTION") headings.SUBSECTION = undefined;
      current = null;
      continue;
    }
    if ((m = line.match(RE.annex))) {
      const id = `${base}/ANNEX:${m[2]}${m[3] ? `-${m[3]}` : ""}`;
      ctx = null;
      push("ANNEX", id, null, `[${m[1]} ${m[2]}${m[3] ? `의${m[3]}` : ""}]`, rawOf(m[4] ?? ""), ln, `${m[1]} ${m[2]}${m[3] ? `의${m[3]}` : ""}`);
      continue;
    }
    if ((m = line.match(RE.article))) {
      const no = Number(m[1]); const dash = !!m[2]; const br1 = Number(m[2] ?? m[4] ?? 0); const br2 = Number(m[3] ?? 0);
      const br = br1 * 1000 + br2; // 정렬용 (제2-1조 < 제2-1조의2 < 제2-2조)
      const title = m[5]; const rest = m[6] ?? "";
      const name = dash ? `제${no}-${br1}조${br2 ? `의${br2}` : ""}` : `제${no}조${br1 ? `의${br1}` : ""}`;
      // 줄 머리 "제N조"라도 제목 괄호나 "삭제"가 없으면 본문 인용으로 본다 (예: "제5조제1항에 따라 …")
      const looksHeader = title !== undefined || /^삭제/u.test(rest) || rest === "" || rest === "생략"; // "제2조 생략": 타법개정 부칙의 생략 조
      const forward = !ctx || no > ctx.articleNo || (no === ctx.articleNo && br > ctx.articleBranch);
      if (looksHeader && forward) {
        const key: string = `${base}/${ns}ARTICLE:${no}${br1 ? `-${br1}` : ""}${br2 ? `-${br2}` : ""}`;
        const label: string = `${ns ? "부칙 " : ""}${name}`;
        ctx = { articleNo: no, articleBranch: br, articleKey: key, articleLabel: label, paraNo: 0, paraKey: null, paraLabel: "", itemNo: 0, itemBranch: 0, itemKey: null, itemLabel: "", subitemIdx: -1 };
        const parent = ns ? `${base}/${ns.slice(0, -1)}` : null;
        const inlineChild = /^[\u2460]|^1\.\s/u.test(rest);
        push("ARTICLE", key, parent, name, inlineChild ? "" : rawOf(rest), ln, label, title);
        if (inlineChild) queue.unshift({ raw: rawOf(rest), ln });
        continue;
      }
      if (looksHeader && !forward) issues.push({ code: "NUMBER_REGRESSION", line: ln, message: `조 번호 역행: ${line.slice(0, 20)}` });
    }
    if (ctx && (m = line.match(RE.paragraph))) {
      const no = m[1] ? circledToInt(m[1]) : Number(m[2]);
      if (no === ctx.paraNo + 1) {
        ctx.paraNo = no; ctx.paraKey = `${ctx.articleKey}/PARAGRAPH:${no}`; ctx.paraLabel = `${ctx.articleLabel}제${no}항`;
        ctx.itemNo = 0; ctx.itemBranch = 0; ctx.itemKey = null; ctx.subitemIdx = -1;
        push("PARAGRAPH", ctx.paraKey, ctx.articleKey, m[1] ?? `<${m[2]}>`, rawOf(m[3] ?? ""), ln, ctx.paraLabel);
        continue;
      }
      issues.push({ code: "NUMBER_REGRESSION", line: ln, message: `항 번호 불연속: ${m[1]} (이전 ${ctx.paraNo})` });
    }
    if (ctx && (m = line.match(RE.item))) {
      const no = Number(m[1]); const br = m[2] ? Number(m[2]) : 0;
      const ok = br ? no === ctx.itemNo && br > ctx.itemBranch : no === ctx.itemNo + 1;
      if (ok) {
        const parentKey = ctx.paraKey ?? ctx.articleKey;
        const parentLabel = ctx.paraKey ? ctx.paraLabel : ctx.articleLabel;
        ctx.itemNo = no; ctx.itemBranch = br; ctx.subitemIdx = -1;
        ctx.itemKey = `${parentKey}/ITEM:${no}${br ? `-${br}` : ""}`;
        ctx.itemLabel = `${parentLabel}제${no}호${br ? `의${br}` : ""}`;
        push("ITEM", ctx.itemKey, parentKey, `${no}${br ? `의${br}` : ""}.`, rawOf(m[3] ?? ""), ln, ctx.itemLabel);
        continue;
      }
      if (no <= 30) issues.push({ code: "NUMBER_REGRESSION", line: ln, message: `호 번호 불연속: ${no} (이전 ${ctx.itemNo})` });
    }
    if (ctx?.itemKey && (m = line.match(RE.subitem))) {
      const idx = SUBITEM_CHARS.indexOf(m[1] as SubitemChar);
      if (idx === ctx.subitemIdx + 1) {
        ctx.subitemIdx = idx;
        const code = SUBITEM_CODES[m[1] as SubitemChar];
        push("SUBITEM", `${ctx.itemKey}/SUBITEM:${code}`, ctx.itemKey, `${m[1]}.`, rawOf(m[2] ?? ""), ln, `${ctx.itemLabel}${m[1]}목`);
        continue;
      }
      issues.push({ code: "NUMBER_REGRESSION", line: ln, message: `목 순서 불연속: ${m[1]}` });
    }
    // 이어쓰기
    const cur = current as Provision | null;
    if (cur) cur.original_text += (cur.original_text ? "\n" : "") + rawLine;
    else if (provisions.length > 0 || /^제\d+조/u.test(line)) issues.push({ code: "ORPHAN_TEXT", line: ln, message: line.slice(0, 30) });
  }

  for (const p of provisions) finalizeNode(p);
  resolveReferences(provisions, meta, issues);
  for (const p of provisions) if (!p.normalized_text && p.status !== "DELETED" && p.level === "ARTICLE" && !provisions.some((c) => c.parent_id === p.provision_id)) {
    issues.push({ code: "EMPTY_PROVISION", line: p.source_line, message: p.provision_id });
  }

  return ParsedLaw.parse({
    law_id: meta.law_id, law_name: meta.law_name, revision_id: meta.revision_id,
    effective_from: meta.effective_from ?? Number(meta.revision_id.replaceAll("-", "")),
    parser_version: PARSER_VERSION, provisions, issues,
  });
}

/** 태그를 본문에서 분리해 메타데이터로 옮기고, 삭제 상태를 판정한다 */
function finalizeNode(p: Provision): void {
  let t = p.original_text.normalize("NFC");
  const del = t.match(RE.deleted);
  if (del) { p.status = "DELETED"; p.deletion_date = isoFromDotted(del[1]!); }
  t = t.replace(RE.amend, (_m, kind: "개정" | "신설", dates: string) => {
    p.amendments.push({ kind, dates: [...dates.matchAll(new RegExp(DATE, "gu"))].map((d) => isoFromDotted(d[0])) });
    return " ";
  });
  t = t.replace(RE.moved, (_m, from: string) => { p.tail_tags["moved_from"] = from.trim(); return " "; });
  t = t.replace(RE.tailTag, (_m, k: string, v: string) => { p.tail_tags[k] = v.trim(); return " "; });
  if (p.status === "DELETED") t = "";
  p.normalized_text = normalizeText(t);
}
