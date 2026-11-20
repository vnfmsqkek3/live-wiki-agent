// Reference Resolver (docs/01 7.8). 참조 표현을 추출해 실제 provision_id로 해석한다.
// 해석 결과는 반드시 파싱된 조문 집합에 존재해야 하며, 없으면 target_id=null(미해결) + issue.
import { SUBITEM_CHARS, SUBITEM_CODES } from "@hanaeum/schemas";
import type { ParsedLaw, Provision, Reference, SubitemChar } from "@hanaeum/schemas";
import type { LawMeta } from "./parse.ts";

const SUB = `[${SUBITEM_CHARS.join("")}]`;
const EXTERNAL = new RegExp(String.raw`「([^」]+)」\s*제(\d+)조(?:의(\d+))?(?:\s*제(\d+)항)?(?:\s*제(\d+)호(?:의(\d+))?)?(?:\s*(${SUB})목)?`, "gu");
const ABSOLUTE = new RegExp(String.raw`제(\d+)(?:-(\d+)조(?:의(\d+))?|조(?:의(\d+))?)(?:\s*제(\d+)항)?(?:\s*제(\d+)호(?:의(\d+))?)?(?:\s*(${SUB})목)?`, "gu");
const PARA_ONLY = new RegExp(String.raw`(?<![조\d])제(\d+)항(?:\s*제(\d+)호(?:의(\d+))?)?(?:\s*(${SUB})목)?`, "gu");
const RELATIVE = /전항|전조|같은\s*조|같은\s*항|다음\s*각\s*호|각\s*호|다음\s*각\s*목|각\s*목/gu;
const ANNEX = /별표\s*(\d+)(?:의(\d+))?/gu;
const EXCEPTION_AFTER = /^\s*(?:의\s*[^\s,.]*?)?에도\s*불구하고/u;

export interface ExternalLawIndex { [lawName: string]: string } // 법령명 → `{law_id}@{rev}`

function buildPath(base: string, art: string, artBr?: string, para?: string, item?: string, itemBr?: string, sub?: string): string {
  let id = `${base}/ARTICLE:${art}${artBr ? `-${artBr}` : ""}`;
  if (para) id += `/PARAGRAPH:${para}`;
  if (item) id += `/ITEM:${item}${itemBr ? `-${itemBr}` : ""}`;
  if (sub) id += `/SUBITEM:${SUBITEM_CODES[sub as SubitemChar]}`;
  return id;
}

const ancestor = (byId: Map<string, Provision>, p: Provision, level: Provision["level"]): Provision | undefined => {
  let cur: Provision | undefined = p;
  while (cur && cur.level !== level) cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  return cur;
};

/** 항·호가 생략된 조 경로("제12조제1호")는 항 1개짜리 조라면 항을 보완해 재시도 */
function existsLoose(byId: Map<string, Provision>, id: string): string | null {
  if (byId.has(id)) return id;
  const m = id.match(/^(.*\/ARTICLE:[\d-]+)(\/ITEM:.*)$/u);
  if (m && byId.has(`${m[1]}/PARAGRAPH:1${m[2]}`)) return `${m[1]}/PARAGRAPH:1${m[2]}`;
  // 부칙 안의 "종전의 제N조"처럼 부칙 네임스페이스에 없으면 본칙에서 찾는다
  const main = id.replace(/\/SUPPLEMENTARY:\d+(?=\/ARTICLE:)/u, "");
  return main !== id ? existsLoose(byId, main) : null;
}

export function extractReferences(p: Provision, byId: Map<string, Provision>, ordered: Provision[], meta: LawMeta, external: ExternalLawIndex = {}): Reference[] {
  const base = `${meta.law_id}@${meta.revision_id}`;
  const nsBase = p.provision_id.includes("/SUPPLEMENTARY:") ? p.provision_id.replace(/\/ARTICLE:.*$/u, "") : base;
  let text = p.normalized_text;
  const refs: Reference[] = [];
  const isExc = (end: number) => EXCEPTION_AFTER.test(p.normalized_text.slice(end));
  const mask = (s: number, e: number) => { text = text.slice(0, s) + " ".repeat(e - s) + text.slice(e); };

  for (const m of [...text.matchAll(EXTERNAL)]) {
    const [raw, law, a, ab, pa, it, ib, su] = m;
    const target = law === meta.law_name ? base : external[law!.replace(/\s/gu, "")];
    refs.push({ raw: raw!, kind: law === meta.law_name ? "ABSOLUTE" : "EXTERNAL", target_id: target ? buildPath(target, a!, ab, pa, it, ib, su) : null, exception_candidate: isExc(m.index! + raw!.length) });
    mask(m.index!, m.index! + raw!.length);
  }
  for (const m of [...text.matchAll(ABSOLUTE)]) {
    const [raw, a, db, db2, ub, pa, it, ib, su] = m; // 제9-5조 = 제9조의5 (ARTICLE:9-5), 제2-1조의2 = ARTICLE:2-1-2
    const ab = db ? (db2 ? `${db}-${db2}` : db) : ub;
    refs.push({ raw: raw!, kind: "ABSOLUTE", target_id: buildPath(nsBase, a!, ab, pa, it, ib, su), exception_candidate: isExc(m.index! + raw!.length) });
    mask(m.index!, m.index! + raw!.length);
  }
  const art = ancestor(byId, p, "ARTICLE");
  const para = ancestor(byId, p, "PARAGRAPH");
  for (const m of [...text.matchAll(PARA_ONLY)]) {
    const [raw, pa, it, ib, su] = m;
    refs.push({ raw: raw!, kind: "ABSOLUTE", target_id: art ? `${art.provision_id}/PARAGRAPH:${pa}${it ? `/ITEM:${it}${ib ? `-${ib}` : ""}` : ""}${su ? `/SUBITEM:${SUBITEM_CODES[su as SubitemChar]}` : ""}` : null, exception_candidate: isExc(m.index! + raw!.length) });
    mask(m.index!, m.index! + raw!.length);
  }
  for (const m of [...text.matchAll(RELATIVE)]) {
    const raw = m[0].replace(/\s+/gu, " ");
    let target: string | null = null;
    if (raw === "전항" && para) {
      const n = Number(para.provision_id.split("PARAGRAPH:")[1]!.split("/")[0]);
      target = n > 1 ? `${art!.provision_id}/PARAGRAPH:${n - 1}` : null;
    } else if (raw === "전조" && art) {
      const arts = ordered.filter((x) => x.level === "ARTICLE" && x.parent_id === art.parent_id);
      const i = arts.indexOf(art);
      target = i > 0 ? arts[i - 1]!.provision_id : null;
    } else if (/^같은 ?조$/u.test(raw)) target = art?.provision_id ?? null;
    else if (/^같은 ?항$/u.test(raw)) target = para?.provision_id ?? null;
    else if (/각 ?호$/u.test(raw)) target = (para ?? art)?.provision_id ?? null; // 각 호를 포함하는 상위
    else if (/각 ?목$/u.test(raw)) target = ancestor(byId, p, "ITEM")?.provision_id ?? null;
    refs.push({ raw, kind: "RELATIVE", target_id: target, exception_candidate: isExc(m.index! + m[0].length) });
  }
  for (const m of [...p.normalized_text.matchAll(ANNEX)]) {
    refs.push({ raw: m[0], kind: "ANNEX", target_id: `${base}/ANNEX:${m[1]}${m[2] ? `-${m[2]}` : ""}`, exception_candidate: false });
  }
  return refs;
}

export function resolveReferences(provisions: Provision[], meta: LawMeta, issues: ParsedLaw["issues"], external: ExternalLawIndex = {}): void {
  const byId = new Map(provisions.map((p) => [p.provision_id, p]));
  const internal = `${meta.law_id}@${meta.revision_id}/`;
  for (const p of provisions) {
    if (p.status === "DELETED" || p.level === "ANNEX") continue;
    p.references = extractReferences(p, byId, provisions, meta, external).map((r) => {
      if (!r.target_id || !r.target_id.startsWith(internal)) return r;
      const hit = existsLoose(byId, r.target_id);
      if (!hit) {
        issues.push({ code: "UNRESOLVED_REF", line: p.source_line, message: `${r.raw} → ${r.target_id}` });
        return { ...r, target_id: null };
      }
      if (byId.get(hit)!.status === "DELETED") issues.push({ code: "REF_TO_DELETED", line: p.source_line, message: `${r.raw} → ${hit}` });
      return { ...r, target_id: hit };
    });
  }
}
