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

const DATE = String.raw`\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\.?`;
const RE = {
  heading: /^제(\d+)(편|장|절)\s+(.+)$/u,
  // 제목 괄호 뒤에는 공백·줄끝이 와야 한다 ("제10조(특례)에 따른 …" 같은 본문 인용 줄을 조로 오인하지 않게)
  article: /^제(\d+)조(?:의(\d+))?(?:\s*\(([^)]*)\)(?=\s|$))?\s*(.*)$/u,
  paragraph: /^([①-⑳㉑-㉟㊱-㊿])\s*(.*)$/u, // ①~⑳, ㉑~㉟, ㊱~㊿
  item: /^(\d+)(?:의(\d+))?\.\s*(.*)$/u,
  subitem: new RegExp(`^([${SUBITEM_CHARS.join("")}])\\.\\s*(.*)$`, "u"),
  supplementary: /^부\s*칙(?:\s*<([^>]+)>)?\s*$/u,
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
  const headings: { PART?: string; CHAPTER?: string; SECTION?: string } = {};
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
      heading_path: [headings.PART, headings.CHAPTER, headings.SECTION].filter((h): h is string => !!h),
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
    if (!line) continue;
    let m: RegExpMatchArray | null;

    if ((m = line.match(RE.supplementary))) {
      suppCount++;
      ns = `SUPPLEMENTARY:${suppCount}/`;
      ctx = null;
      push("SUPPLEMENTARY", `${base}/SUPPLEMENTARY:${suppCount}`, null, "부칙", line, ln, "부칙", m[1]);
      continue;
    }
    if ((m = line.match(RE.heading))) {
      const lvl = ({ 편: "PART", 장: "CHAPTER", 절: "SECTION" } as const)[m[2] as "편" | "장" | "절"];
      headings[lvl] = line;
      if (lvl === "PART") { headings.CHAPTER = undefined; headings.SECTION = undefined; }
      if (lvl === "CHAPTER") headings.SECTION = undefined;
      current = null;
      continue;
    }
    if ((m = line.match(RE.annex))) {
      const id = `${base}/ANNEX:${m[2]}${m[3] ? `-${m[3]}` : ""}`;
      ctx = null;
      push("ANNEX", id, null, `[${m[1]} ${m[2]}${m[3] ? `의${m[3]}` : ""}]`, m[4] ?? "", ln, `${m[1]} ${m[2]}${m[3] ? `의${m[3]}` : ""}`);
      continue;
    }
    if ((m = line.match(RE.article))) {
      const no = Number(m[1]); const br = m[2] ? Number(m[2]) : 0;
      const title = m[3]; const rest = m[4] ?? "";
      // 줄 머리 "제N조"라도 제목 괄호나 "삭제"가 없으면 본문 인용으로 본다 (예: "제5조제1항에 따라 …")
      const looksHeader = title !== undefined || /^삭제/u.test(rest) || rest === "";
      const forward = !ctx || no > ctx.articleNo || (no === ctx.articleNo && br > ctx.articleBranch);
      if (looksHeader && forward) {
        const key: string = `${base}/${ns}ARTICLE:${no}${br ? `-${br}` : ""}`;
        const label: string = `${ns ? "부칙 " : ""}제${no}조${br ? `의${br}` : ""}`;
        ctx = { articleNo: no, articleBranch: br, articleKey: key, articleLabel: label, paraNo: 0, paraKey: null, paraLabel: "", itemNo: 0, itemBranch: 0, itemKey: null, itemLabel: "", subitemIdx: -1 };
        const parent = ns ? `${base}/${ns.slice(0, -1)}` : null;
        const inlineChild = /^[\u2460]|^1\.\s/u.test(rest);
        push("ARTICLE", key, parent, `제${no}조${br ? `의${br}` : ""}`, inlineChild ? "" : rest, ln, label, title);
        if (inlineChild) queue.unshift({ raw: rest, ln });
        continue;
      }
      if (looksHeader && !forward) issues.push({ code: "NUMBER_REGRESSION", line: ln, message: `조 번호 역행: ${line.slice(0, 20)}` });
    }
    if (ctx && (m = line.match(RE.paragraph))) {
      const no = circledToInt(m[1]!);
      if (no === ctx.paraNo + 1) {
        ctx.paraNo = no; ctx.paraKey = `${ctx.articleKey}/PARAGRAPH:${no}`; ctx.paraLabel = `${ctx.articleLabel}제${no}항`;
        ctx.itemNo = 0; ctx.itemBranch = 0; ctx.itemKey = null; ctx.subitemIdx = -1;
        push("PARAGRAPH", ctx.paraKey, ctx.articleKey, m[1]!, m[2] ?? "", ln, ctx.paraLabel);
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
        push("ITEM", ctx.itemKey, parentKey, `${no}${br ? `의${br}` : ""}.`, m[3] ?? "", ln, ctx.itemLabel);
        continue;
      }
      if (no <= 30) issues.push({ code: "NUMBER_REGRESSION", line: ln, message: `호 번호 불연속: ${no} (이전 ${ctx.itemNo})` });
    }
    if (ctx?.itemKey && (m = line.match(RE.subitem))) {
      const idx = SUBITEM_CHARS.indexOf(m[1] as SubitemChar);
      if (idx === ctx.subitemIdx + 1) {
        ctx.subitemIdx = idx;
        const code = SUBITEM_CODES[m[1] as SubitemChar];
        push("SUBITEM", `${ctx.itemKey}/SUBITEM:${code}`, ctx.itemKey, `${m[1]}.`, m[2] ?? "", ln, `${ctx.itemLabel}${m[1]}목`);
        continue;
      }
      issues.push({ code: "NUMBER_REGRESSION", line: ln, message: `목 순서 불연속: ${m[1]}` });
    }
    // 이어쓰기
    const cur = current as Provision | null;
    if (cur) cur.original_text += (cur.original_text ? "\n" : "") + line;
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
