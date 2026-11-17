// 업로드 문서 메타 (사용자 요청 11/17): 문서 일자·제목 후보·같은 문서 판별·버전 간 변경점.
// 모델 없이 결정적으로. 제목은 AI 분류(Classify)가 더 나은 제목을 내면 그쪽이 우선이고, 여기 값은 기본값·대조용.
import { parseLaw } from "./parse.ts";
import { diffLaws } from "./diff.ts";
import type { ParsedLaw } from "@hanaeum/schemas";

export type DateKind = "제정" | "개정" | "시행" | "작성" | "발행" | "기준";
export interface DocDate { kind: DateKind; date: string; page: number } // date YYYY-MM-DD, page 0부터

const DATE = String.raw`(\d{4})\s*(?:[.\-/]|년)\s*(\d{1,2})\s*(?:[.\-/]|월)\s*(\d{1,2})\s*(?:일|\.)?`;
// "개정일: 2026. 11. 1." "시행 2026-12-01" "<개정 2026. 11. 1.>" "작성일자 2026년 10월 15일" "기준일 …"
const LABELED = new RegExp(String.raw`(제정|개정|시행|작성|발행|기준)(?:일자|일)?[^\d\n]{0,12}?` + DATE, "gu");
const MORE = new RegExp(String.raw`^\s*,\s*` + DATE, "u"); // "<개정 2019. 1. 1., 2026. 11. 1.>" 이어지는 날짜
const FROM = new RegExp(DATE + String.raw`\s*부터\s*시행`, "gu"); // 부칙 "2026년 11월 1일부터 시행한다"

const valid = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return y >= 1948 && y <= 2100 && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

/** 본문에 적힌 일자 전부 (라벨 붙은 것만. 라벨 없는 날짜는 거래일·예시일 수 있어 쓰지 않는다) */
export function docDates(pages: string[]): DocDate[] {
  const out: DocDate[] = [];
  const add = (kind: DateKind, y: number, mo: number, d: number, page: number) => {
    if (valid(y, mo, d)) out.push({ kind, date: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`, page });
  };
  pages.forEach((text, page) => {
    for (const m of text.matchAll(LABELED)) {
      add(m[1] as DateKind, Number(m[2]), Number(m[3]), Number(m[4]), page);
      let rest = text.slice(m.index + m[0].length);
      for (let n = MORE.exec(rest); n; n = MORE.exec(rest)) { add(m[1] as DateKind, Number(n[1]), Number(n[2]), Number(n[3]), page); rest = rest.slice(n[0].length); }
    }
    for (const m of text.matchAll(FROM)) add("시행", Number(m[1]), Number(m[2]), Number(m[3]), page);
  });
  return out;
}

const RANK: DateKind[] = ["시행", "개정", "작성", "발행", "제정", "기준"];
/** 대표 일자: 시행 > 개정 > 작성 > 발행 > 제정 > 기준, 같은 종류면 가장 늦은 날 (개정 이력이 여러 줄이면 최신) */
export function primaryDate(dates: DocDate[]): DocDate | undefined {
  for (const k of RANK) {
    const xs = dates.filter((d) => d.kind === k);
    if (xs.length) return xs.reduce((a, b) => (b.date > a.date ? b : a));
  }
  return undefined;
}

/** 제목 후보: 표시줄(SYNTHETIC…)·조문·문장을 건너뛴 첫 제목줄. 없으면 파일 이름 */
export function titleCandidate(pages: string[], filename = ""): string {
  for (const raw of (pages[0] ?? "").split("\n").slice(0, 15)) {
    const line = raw.replace(/^#+\s*/u, "").replace(/^\[SYNTHETIC\]\s*/u, "").trim();
    if (line.length < 4 || line.length > 60) continue;
    if (/^SYNTHETIC|^제\s*\d+\s*조|^[①-⑳\d]+[.)]|^[-*·•]|[다요]\.$|:$/u.test(line)) continue;
    if (/^(?:시행일|개정일|작성일|제정일|발행일|작성자|담당|문서번호)/u.test(line)) continue;
    return line;
  }
  return filename.replace(/\.[^.]+$/u, "").replace(/[_]+/gu, " ").trim() || "제목 없음";
}

// ── 같은 문서 판별 ─────────────────────────────────────
const norm = (s: string) => s.replace(/^SYNTHETIC[^\n]*/u, "").replace(/\s+/gu, ""); // 표시줄 먼저 (공백 제거 후엔 줄 경계가 없음)
const shingles = (s: string) => { const t = norm(s); const set = new Set<string>(); for (let i = 0; i + 3 <= t.length; i++) set.add(t.slice(i, i + 3)); return set; };
/** 본문 3글자 조각 자카드 유사도 (0~1). 같은 문서의 개정본은 보통 0.6 이상, 다른 문서는 0.3 미만 */
export function similarity(a: string, b: string): number {
  const x = shingles(a), y = shingles(b);
  if (!x.size || !y.size) return 0;
  let inter = 0; for (const s of x) if (y.has(s)) inter++;
  return inter / (x.size + y.size - inter);
}
export interface VersionCandidate { doc_id: string; title: string; text: string; law_id?: string }
/** 새 문서의 이전 버전 후보: 같은 law_id(규정) 또는 제목이 같고/본문 유사도 ≥ 0.5. 점수 높은 순 최대 3건.
 *  ponytail: 후보 전체와 비교 O(n·본문), 문서 수천 건이면 KB 유사 검색으로 후보를 먼저 줄인다 */
export function previousVersionCandidates(doc: { title: string; text: string; law_id?: string }, candidates: VersionCandidate[]): { doc_id: string; title: string; score: number; reason: string }[] {
  return candidates.filter((c) => c.text !== doc.text || c.title !== doc.title).map((c) => {
    if (doc.law_id && c.law_id === doc.law_id) return { doc_id: c.doc_id, title: c.title, score: 1, reason: "같은 규정(법령 ID)" };
    const sim = similarity(doc.text, c.text);
    const sameTitle = !!norm(doc.title) && norm(c.title) === norm(doc.title); // 빈 제목끼리는 같은 제목 아님
    const score = Math.min(1, sim + (sameTitle ? 0.3 : 0));
    return { doc_id: c.doc_id, title: c.title, score, reason: sameTitle ? `제목 같음, 본문 ${Math.round(sim * 100)}% 일치` : `본문 ${Math.round(sim * 100)}% 일치` };
  }).filter((x) => x.score >= 0.5).sort((a, b) => b.score - a.score).slice(0, 3);
}

// ── 버전 간 변경점 ─────────────────────────────────────
export interface DocChange {
  kind: "ADDED" | "REMOVED" | "CHANGED";
  /** 사람이 읽는 위치: 규정은 "제12조제1항", 그 밖은 "3쪽" */
  where: string;
  old_page: number | null; new_page: number | null; // 0부터
  old_text: string; new_text: string;
  numbers_changed?: { old: string[]; new: string[] };
}

const META = { law_id: "DIFF", law_name: "", revision_id: "2000-01-01", effective_from: 20000101 };
const articles = (l: ParsedLaw) => l.provisions.filter((p) => p.level === "ARTICLE").length;
const lineOf = (pages: string[], needle: string) => { const n = norm(needle).slice(0, 20); const p = pages.findIndex((t) => norm(t).includes(n)); return p < 0 ? null : p; };

/** 조문 구조가 있으면(양쪽 다 조 3개 이상) 조·항·호 단위 비교, 아니면 줄 단위 비교 */
export function diffDocuments(oldPages: string[], newPages: string[]): DocChange[] {
  const o = parseLaw(oldPages.join("\n"), META), n = parseLaw(newPages.join("\n"), META);
  if (articles(o) >= 3 && articles(n) >= 3) {
    const label = new Map([...o.provisions, ...n.provisions].map((p) => [p.provision_id.split("/").slice(1).join("/"), p.path_label]));
    return diffLaws(o, n).filter((c) => !c.path.startsWith("SUPPLEMENTARY:")).map((c) => ({
      kind: c.kind === "ADDED" ? "ADDED" : c.kind === "REMOVED" || c.kind === "DELETED" ? "REMOVED" : "CHANGED",
      where: label.get(c.path) ?? c.path, old_page: c.old_text ? lineOf(oldPages, c.old_text) : null, new_page: c.new_text ? lineOf(newPages, c.new_text) : null,
      old_text: c.old_text, new_text: c.new_text, numbers_changed: c.numbers_changed,
    }));
  }
  return lineDiff(oldPages, newPages);
}

/** 줄 단위 LCS. 연속한 삭제+추가는 CHANGED 한 건으로 묶는다.
 *  ponytail: O(줄수²) 메모리, 각 5천 줄 넘는 문서는 쪽 단위로 먼저 나눠 비교 */
function lineDiff(oldPages: string[], newPages: string[]): DocChange[] {
  const flat = (ps: string[]) => ps.flatMap((t, p) => t.split("\n").map((l) => ({ p, l: l.trim() })).filter((x) => x.l));
  const key = (s: string) => s.replace(/\s+/gu, " ");
  const keyed = (ps: string[]) => flat(ps).map((x) => ({ ...x, k: key(x.l) }));
  let a = keyed(oldPages), b = keyed(newPages);
  // 앞뒤 같은 줄은 비교에서 뺀다 (대부분의 개정은 일부만 바뀜)
  let pre = 0; while (pre < a.length && pre < b.length && a[pre]!.k === b[pre]!.k) pre++;
  let suf = 0; while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf]!.k === b[b.length - 1 - suf]!.k) suf++;
  a = a.slice(pre, a.length - suf); b = b.slice(pre, b.length - suf);
  // ponytail: 남은 줄이 너무 많으면(표 4천만 칸 초과) 쪽 단위로만 알린다
  if ((a.length + 1) * (b.length + 1) > 4e7) {
    return [...new Set([...a, ...b].map((x) => x.p))].sort((x, y) => x - y).map((p) => ({ kind: "CHANGED" as const, where: `${p + 1}쪽`, old_page: p, new_page: p,
      old_text: a.filter((x) => x.p === p).map((x) => x.l).join("\n"), new_text: b.filter((x) => x.p === p).map((x) => x.l).join("\n") }));
  }
  const W = b.length + 1;
  const L = new Uint32Array((a.length + 1) * W);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    L[i * W + j] = a[i]!.k === b[j]!.k ? L[(i + 1) * W + j + 1]! + 1 : Math.max(L[(i + 1) * W + j]!, L[i * W + j + 1]!);
  const out: DocChange[] = [];
  let del: typeof a = [], add: typeof b = [];
  const flush = () => {
    if (!del.length && !add.length) return;
    const kind = del.length && add.length ? "CHANGED" : del.length ? "REMOVED" : "ADDED";
    const page = (add[0] ?? del[0])!.p;
    out.push({ kind, where: `${page + 1}쪽`, old_page: del[0]?.p ?? null, new_page: add[0]?.p ?? null, old_text: del.map((x) => x.l).join("\n"), new_text: add.map((x) => x.l).join("\n") });
    del = []; add = [];
  };
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i]!.k === b[j]!.k) { flush(); i++; j++; }
    else if (j < b.length && (i >= a.length || L[i * W + j + 1]! >= L[(i + 1) * W + j]!)) add.push(b[j++]!);
    else del.push(a[i++]!);
  }
  flush();
  return out;
}
