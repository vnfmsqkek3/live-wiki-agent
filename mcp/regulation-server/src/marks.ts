// 문서보관함 페이지 하이라이트 (요청기록 20261116-2220): 검사·검증 결과를 "몇 페이지 몇 번째 글자부터"로 바꾼다.
// 밑줄마다 이유·근거(조문 원문·시행일)·수정할 사항. 모델 판단은 인용 원문 대조를 통과한 것만 밑줄로 쓴다.
import { isoOfYmd } from "@hanaeum/schemas";
import type { ClauseStore } from "./store.ts";
import type { RegistryMatch } from "./registry.ts";

export type MarkKind = "CONFLICT" | "OUTDATED" | "INSUFFICIENT" | "BASIS_MISMATCH" | "SUPPLEMENT" | "CONFIRMED" | "REGISTRY_MISMATCH" | "PII_UNCERTAIN" | "INJECTION";
/** 화면 표시 이름 (한 곳에서 정함). 고칠 곳(틀림)과 확인 필요(근거 없음)·실무 보완(규정 범위 안 구체화)을 구분한다 */
export const MARK_LABEL: Record<MarkKind, string> = {
  CONFLICT: "고칠 곳", OUTDATED: "개정 전 인용", REGISTRY_MISMATCH: "공식 원본과 다름",
  INSUFFICIENT: "확인 필요", BASIS_MISMATCH: "근거와 다름", SUPPLEMENT: "실무 보완(참고)", CONFIRMED: "근거 확인됨",
  PII_UNCERTAIN: "개인정보 확인 필요", INJECTION: "지시문 의심",
};
export interface Basis { provision_id: string; label: string; text: string; effective_from?: string }
export interface Mark {
  page: number | null; start: number | null; end: number | null; // 위치를 못 찾으면 null (문서 단위 표시)
  severity: "HIGH" | "MEDIUM" | "LOW"; kind: MarkKind; label: string; reason: string; basis?: Basis; fix?: string;
  /** 확인이 필요한 건의 세 칸 (사용자 요청 11/17): 원본 내용(올린 문서의 그 부분) · 근거 내용(basis) · 근거를 바탕으로 한 수정 내용.
   *  original: 올린 문서에 없으면(빠진 조문) null. revision: 고칠 필요 없으면(근거 확인됨) null, 지워야 하면 "(삭제)" */
  original: string | null; revision: string | null;
}
export interface MarkSources {
  /** dhxorb96 KnowhowValidation (apps/api/src/steps/knowhow.ts) */
  knowhow?: {
    /** suggestion: 근거 조문에 맞게 고쳐 쓴 문장 (dhxorb96 knowhow.ts, 있으면 수정 내용으로 그대로 씀) */
    items: { statement: string; provision_id: string; relation: string; reason: string; quote: string; label: string; verified_quote: boolean; suggestion?: string;
      /** 판단 못함(INSUFFICIENT)·무관(UNRELATED)일 때 그 조문을 본문이 근거로 들었는지 (AI PR #99). CITED=든 조문과 내용이 다름, NONE=든 적 없음(무관 조문 표시 금지) */
      basis?: "CITED" | "NONE" }[];
    outdated: { cited: string; current: string; label: string }[];
  };
  /** 규정 문서: registryMatch 결과 (해시 불일치일 때 claimed.clauses 포함) */
  registry?: RegistryMatch;
  /** 단계 Finding. evidence_ref "page:n" 이면 그 페이지 */
  findings?: { step?: string; severity: string; code: string; message: string; evidence_ref: string; user_message?: string; fix_hint?: string; location?: { excerpt?: string } }[];
}

const SKIP = /[\s「」"'“”‘’·ㆍ]/u;
/** 공백·따옴표를 무시하고 찾은 뒤 원래 글자 위치로 되돌린다. 전체가 없으면 앞 30자로 다시 찾는다 */
export function locate(pages: string[], needle: string): { page: number; start: number; end: number } | null {
  const n = [...needle].filter((c) => !SKIP.test(c)).join("");
  if (n.length < 4) return null;
  for (const probe of [n, n.slice(0, 30)]) {
    for (let p = 0; p < pages.length; p++) {
      const chars = [...pages[p]!];
      const idx: number[] = []; let norm = ""; let off = 0;
      for (const c of chars) { if (!SKIP.test(c)) { idx.push(off); norm += c; } off += c.length; }
      const at = norm.indexOf(probe);
      if (at < 0) continue;
      const last = at + [...probe].length - 1;
      return { page: p, start: idx[at]!, end: idx[last]! + [...norm][last]!.length };
    }
  }
  return null;
}

/** needle이 anchor(법령 이름) 바로 뒤 40자 안에 나오는 자리가 정확히 한 곳이면 그 위치 */
function locateNear(pages: string[], needle: string, anchor: string): { page: number; start: number; end: number } | null {
  if (!anchor) return null;
  const hits: { page: number; start: number; end: number }[] = [];
  for (let p = 0; p < pages.length; p++) {
    const t = pages[p]!;
    for (let i = t.indexOf(needle); i >= 0; i = t.indexOf(needle, i + 1)) {
      if (t.slice(Math.max(0, i - 40), i).includes(anchor)) hits.push({ page: p, start: i, end: i + needle.length });
    }
  }
  return hits.length === 1 ? hits[0]! : null;
}

const iso = (n?: number) => (n ? isoOfYmd(n) : undefined);

/** 조문 ID → 근거 (원문·표기·시행일). 저장소에 없으면 undefined */
async function basisOf(store: ClauseStore, pid: string): Promise<Basis | undefined> {
  const [lawRev] = pid.split("/");
  const [lawId, revId] = lawRev!.split("@") as [string, string];
  const rev = (await store.revisions(lawId)).find((r) => r.revision_id === revId);
  const provs = (await store.provisions(lawId, revId)) ?? [];
  const p = provs.find((x) => x.provision_id === pid);
  if (!rev || !p) return undefined;
  const ef = iso(rev.effective_from);
  // 조·항 단위면 하위 항·호·목 원문까지 (조 머리 자체는 본문이 비어 있는 경우가 많음)
  const text = provs.filter((x) => x.provision_id === pid || x.provision_id.startsWith(`${pid}/`))
    .map((x) => `${x.original_marker}${x.title ? `(${x.title})` : ""} ${x.original_text}`.trim()).join("\n");
  return { provision_id: pid, label: `${rev.law_name} ${p.path_label}`, text, ...(ef ? { effective_from: ef } : {}) };
}

const at = (pages: string[], needle: string) => locate(pages, needle) ?? { page: null, start: null, end: null };
const slice = (pages: string[], w: { page: number | null; start: number | null; end: number | null }) =>
  w.page !== null && w.start !== null && w.end !== null ? pages[w.page]!.slice(w.start, w.end) : null;
/** 밑줄 문구가 들어 있는 문장 전체 (마침표·줄바꿈 기준) */
// 문장 끝 = 줄바꿈, 또는 "다." "요." "s." ")." 처럼 글자 뒤 마침표. 날짜 "2025. 1. 1."의 숫자 뒤 마침표는 끝이 아님
const endsAt = (t: string, i: number) => t[i] === "\n" || (/[.!?]/u.test(t[i]!) && i > 0 && /[다요까함것음임라니A-Za-z)」]/u.test(t[i - 1]!));
export function sentenceAt(text: string, start: number, end: number): string {
  let s = start; while (s > 0 && !endsAt(text, s - 1)) s--;
  let e = Math.max(start, end - 1); while (e < text.length - 1 && !endsAt(text, e)) e++;
  return text.slice(s, e + 1).trim();
}
/** "…첨부한다." → "…첨부하는 것을 권장한다." (규정상 의무가 아님을 문장에 드러냄). 형태가 다르면 괄호로 덧붙임 */
export function asRecommendation(st: string): string {
  const t = st.trim();
  return /한다\.?$/u.test(t) ? t.replace(/한다\.?$/u, "하는 것을 권장한다.") : `${t.replace(/\.$/u, "")} (권장 사항이며 규정상 의무는 아님).`;
}
const POLICY: Record<"INJECTION" | "PII_UNCERTAIN", Basis> = {
  INJECTION: { provision_id: "POLICY:INJECTION", label: "보안 검사 기준", text: "문서 안에 AI에게 지시하거나 역할·권한을 바꾸게 하는 문장이 있으면 게시할 수 없습니다. 업무 설명은 사람이 읽는 문장으로 씁니다." },
  PII_UNCERTAIN: { provision_id: "POLICY:PII", label: "개인정보 기준", text: "주민·외국인등록·여권·운전면허번호, 계좌·카드·전화번호, 이메일, 고객번호처럼 개인을 식별하는 값은 지우거나 가린 뒤 올립니다." },
};

/** 두 문장의 다른 부분만 앞뒤 8자와 함께: "분기마다" vs "매월" 처럼 무엇이 바뀌었는지 한눈에 */
export function diffSpan(a: string, b: string): { mine: string; official: string } {
  const x = [...a], y = [...b];
  let i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i++;
  let j = 0; while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
  const cut = (c: string[]) => { const s = Math.max(0, i - 8), e = Math.min(c.length, c.length - j + 8);
    return `${s > 0 ? "…" : ""}${c.slice(s, e).join("")}${e < c.length ? "…" : ""}`; };
  return { mine: cut(x), official: cut(y) };
}
const subtree = (c: Record<string, string>, k: string) => Object.keys(c).filter((x) => x === k || x.startsWith(`${k}/`)).sort().map((x) => c[x]).join(" ").trim();

export async function buildMarks(pages: string[], src: MarkSources, store: ClauseStore): Promise<Mark[]> {
  const marks: Mark[] = [];
  for (const it of src.knowhow?.items ?? []) {
    // 판정 → 표시. 모델 판단은 인용 원문 대조를 통과한 것만 확정(충돌·일치). 실무 보완 = 규정이 정한 범위 안에서 노하우가 구체화한 내용(의무 아님)
    // 근거로 든 조문과 내용이 다름(basis=CITED) → '근거와 다름'. 든 적 없는 조문(basis=NONE)은 근거로 보이지 않는다 (사용자 피드백 11/20: '처리 결과 안내'에 비대면 개설 조문)
    const kind: MarkKind | undefined = it.basis === "CITED" && (it.relation === "INSUFFICIENT" || it.relation === "UNRELATED") ? "BASIS_MISMATCH"
      : ({ CONFLICTS: "CONFLICT", INSUFFICIENT: "INSUFFICIENT", SUPPLEMENTS: "SUPPLEMENT", SUPPORTS: "CONFIRMED" }[it.relation] as MarkKind | undefined);
    if (!kind) continue;
    if ((kind === "CONFLICT" || kind === "CONFIRMED") && !it.verified_quote) continue;
    const basis = it.basis === "NONE" ? undefined : await basisOf(store, it.provision_id);
    const MISMATCH = "근거로 든 조항과 다른 내용으로 보입니다. 해당 부분을 다시 확인하세요.";
    const fix = { BASIS_MISMATCH: MISMATCH, CONFLICT: `근거 조문에 맞게 수정: "${it.quote}"`, INSUFFICIENT: "근거 조문을 명시하거나 담당 부서에 확인해 주세요",
      SUPPLEMENT: "규정이 요구하는 의무가 아니라 권장 사항임을 문장에 밝혀 주세요 (예: '첨부하는 것을 권장한다')" } as Partial<Record<MarkKind, string>>;
    const w = at(pages, it.statement);
    // 수정 내용: 모델이 근거 조문에 맞게 고쳐 쓴 문장(suggestion) 우선. 없으면 충돌=근거 조문 문구, 실무 보완=권장 표현, 근거 확인됨=수정 없음
    // 실무 보완은 모델 수정문을 쓰지 않는다 (모델이 의무를 '권장'으로 낮추는 등 내용을 바꿈 — dhxorb96 실측 11/17). suggestion은 충돌에만 옴
    const revision = kind === "CONFIRMED" ? null : kind === "SUPPLEMENT" ? asRecommendation(it.statement) : kind === "CONFLICT" ? it.suggestion ?? it.quote : null; // 근거와 다름: 고쳐 쓸 문장이 없음(안내문은 fix 에만, 웹 [적용]이 본문을 안내문으로 바꾸지 않게)
    marks.push({
      ...w, kind, label: MARK_LABEL[kind],
      severity: kind === "CONFLICT" ? "HIGH" : kind === "INSUFFICIENT" || kind === "BASIS_MISMATCH" ? "MEDIUM" : "LOW", reason: it.reason,
      ...(basis ? { basis } : {}), ...(fix[kind] ? { fix: fix[kind] } : {}),
      original: slice(pages, w) ?? it.statement, revision,
    });
  }
  for (const o of src.knowhow?.outdated ?? []) {
    const basis = await basisOf(store, o.current);
    const cited = await basisOf(store, o.cited);
    // 본문에는 "제14조제1항"처럼 조문 표기만 쓰는 경우가 많다. 다른 법령의 같은 조문 표기에 잘못 걸리지 않도록
    // 그 법령 이름(마지막 단어, 예: 심사규정)이 바로 앞 40자 안에 있고 그런 자리가 한 곳뿐일 때만 위치로 쓴다. 아니면 문서 단위(null)
    const lawWord = (cited?.label ?? o.label).split(" ").slice(0, -1).pop() ?? "";
    const where = locate(pages, cited?.text ?? "") ?? locateNear(pages, o.label.split(" ").pop() ?? o.label, lawWord);
    const w = where ?? { page: null, start: null, end: null };
    marks.push({
      ...w, kind: "OUTDATED", label: MARK_LABEL.OUTDATED, severity: "HIGH",
      reason: `개정 전 조문 인용 (${cited?.effective_from ?? "이전 버전"} 시행분)`,
      ...(basis ? { basis } : {}), fix: basis ? `현행 ${basis.label}(${basis.effective_from ?? ""} 시행)으로 수정: "${basis.text}"` : "현행 조문으로 수정",
      // 원본: 본문에서 찾은 옛 조문 문구(없으면 인용한 옛 조문 원문). 수정: 현행 조문 원문
      original: w.page !== null ? sentenceAt(pages[w.page]!, w.start!, w.end!) : cited?.text ?? o.label,
      revision: basis?.text ?? null,
    });
  }
  /** 어느 조문이 어떻게 다른지 한 문장으로 (사용자 요청 11/17: 결재함에서 무엇이 잘못됐는지 자세히) */
  const reasonOf = (label: string, mine: string, official: string) => {
    if (!mine) return `올린 문서에서 빠진 조문입니다: ${label}. 공식 원문: "${official}"`;
    if (!official) return `공식 원본에 없는 조문입니다: ${label}. 올린 문서: "${mine}"`;
    const d = diffSpan(mine, official);
    return `${label}의 내용이 공식 원본과 다릅니다. 올린 문서 "${d.mine}" ↔ 공식 원본 "${d.official}"`;
  };
  const reg = src.registry;
  if (reg?.registry && reg.claimed?.clauses) {
    const official = reg.registry.clauses; const uploaded = reg.claimed.clauses;
    const has = (c: Record<string, string>, k: string) => k in c || Object.keys(c).some((x) => x.startsWith(`${k}/`));
    const marked: string[] = [];
    const under = (k: string) => marked.some((m) => k.startsWith(`${m}/`));
    for (const path of Object.keys({ ...official, ...uploaded }).filter((k) => official[k] !== uploaded[k]).sort()) {
      if (under(path)) continue; // 상위 조를 이미 "내용이 다름"으로 표시함
      const pid = `${reg.registry.law_id}@${reg.registry.revision_id}/${path}`;
      const basis = await basisOf(store, pid);
      const inOfficial = has(official, path);
      if (uploaded[path] && inOfficial) marked.push(path); // 항 구성이 달라도 조 단위 1건으로
      const mine = uploaded[path] ? subtree(uploaded, path) : "";
      marks.push({
        original: mine || null, revision: inOfficial ? basis?.text ?? subtree(official, path) : "(삭제)",
        ...(uploaded[path] ? at(pages, uploaded[path]) : { page: null, start: null, end: null }),
        kind: "REGISTRY_MISMATCH", label: MARK_LABEL.REGISTRY_MISMATCH, severity: "HIGH",
        reason: reasonOf(basis?.label ?? path, uploaded[path] ? subtree(uploaded, path) : "", inOfficial ? subtree(official, path) : ""),
        ...(basis ? { basis } : {}), fix: inOfficial ? `공식 원문으로 수정: "${basis?.text ?? official[path]}"` : "출처 확인 후 삭제 또는 근거 제시",
      });
    }
  }
  for (const f of src.findings ?? []) {
    // 인젝션은 단계로 판별 (code는 OVERRIDE_KO·ROLE_HIJACK 등), PII는 확인 필요 코드만 (확정 마스킹 PII_MASKED_* 제외)
    const kind: MarkKind | undefined = f.step === "INJECTION_SCAN" ? "INJECTION"
      : f.code.startsWith("PII_UNCERTAIN") || f.code === "PII_GUARDRAIL" ? "PII_UNCERTAIN" : undefined;
    if (!kind) continue;
    const m = /^page:(\d+)$/u.exec(f.evidence_ref);
    // 사용자 문장(user_message)의 따옴표 안 문구를 그 쪽에서 찾아 밑줄. 못 찾으면 쪽 단위
    const quoted = /\("([^"]{4,})"\)/u.exec(f.user_message ?? "")?.[1];
    const page = m ? Number(m[1]) : null;
    const hit = quoted && page !== null && pages[page] !== undefined ? locate([pages[page]!], quoted) : null;
    // 원본: 밑줄 문구가 든 문장(못 찾으면 finding의 마스킹 excerpt). 근거: 보안·개인정보 기준. 수정: 지시문은 삭제, 개인정보는 가림
    const excerpt = f.location?.excerpt?.replace(/^…/u, "") ?? null;
    marks.push({ page, start: hit?.start ?? null, end: hit?.end ?? null, kind, label: MARK_LABEL[kind], severity: f.severity === "HIGH" ? "HIGH" : "MEDIUM",
      original: kind === "INJECTION" && hit ? sentenceAt(pages[page!]!, hit.start, hit.end) : excerpt, basis: POLICY[kind], // 개인정보 건은 항상 마스킹 excerpt
      revision: kind === "INJECTION" ? "(삭제)" : "(해당 값을 지우거나 가림)",
      reason: f.user_message ?? f.message,
      fix: f.fix_hint ?? (kind === "PII_UNCERTAIN" ? "개인정보 여부 확인 후 삭제 또는 가림" : "지시문 형태 문구 삭제") });
  }
  return marks.sort((a, b) => (a.page ?? 1e9) - (b.page ?? 1e9) || (a.start ?? 0) - (b.start ?? 0));
}

