// 청킹 로직 (순수 함수). docs/01 8.1~8.3, docs/04 6.4
// 법령: 항 = 기본 청크, 항 없는 조 = 조 전체, 긴 항은 호 경계에서 분할. 부칙 조·별표는 독립 청크.
// 노하우·매뉴얼: Markdown 제목(##) 단위, 없으면 문서 전체.
// 임베딩 입력(contentBody) = augmented_search_text = 문맥 헤더 + 실제 본문. original_text는 인용용으로 메타데이터에 분리.
import { parseLaw } from "@hanaeum/legal-parser";
import { PII_NAME } from "@hanaeum/pii";
import { FIGURE_RE, isoOfYmd, FIG_CONTEXT_LABEL, FIG_SUMMARY_RE } from "@hanaeum/schemas";
import type { DocumentMetadata, Provision, ProvisionStatus } from "@hanaeum/schemas";

export interface Chunk {
  augmented_search_text: string; // = KB contentBody (임베딩·BM25 대상)
  metadata: DocumentMetadata & {
    provision_id: string; provision_path: string; provision_status: ProvisionStatus;
    parent_id: string; source_page: number; original_text: string;
    has_figure?: boolean; // 그림 청크
    /** 그림 기준 근거 (매뉴얼·노하우의 쪽 정리본만, 인용 가능하되 "그림 기준(AI 정리)"로 표시) */
    evidence_kind?: "FIGURE";
    /** 같은 쪽 그림 제목 (OCR로 확인된 것만). 검색 머리·화면 표시용, 인용 원문 아님 */
    page_context?: string;
    /** 장(章): 쪽 첫 줄의 장 번호("04 브라더 복합기 드라이버", "⑤ …")로 나눈 묶음. 매뉴얼·노하우만 */
    section?: string;
    /** 장의 쪽 범위 "시작-끝" (1부터) */
    section_pages?: string;
  };
}

// ponytail: 글자 수 근사. Titan V2 한도(8k 토큰)보다 충분히 작게 잡음. 실측 후 토크나이저 기준으로 교체
export const MAX_CHUNK_CHARS = 1800;

const fmtDate = isoOfYmd;

/** 노드 + 하위 노드 원문을 순서대로 이어붙임 (마커 포함) */
function subtree(p: Provision, children: Map<string, Provision[]>): Provision[] {
  return [p, ...(children.get(p.provision_id) ?? []).flatMap((c) => subtree(c, children))];
}
const render = (nodes: Provision[], field: "original_text" | "normalized_text") =>
  nodes.map((n) => (n.level === "ARTICLE" ? `${n.original_marker}${n.title ? `(${n.title})` : ""} ` : `${n.original_marker} `) + n[field]).join("\n").trim();

/** pageOfLine: 입력 줄 번호(1부터) → 쪽(0부터). 없으면 0 (쪽 경계 없는 = 한 쪽 문서) */
export function chunkLegal(text: string, meta: DocumentMetadata, pageOfLine: (line: number) => number = () => 0): Chunk[] {
  if (!meta.law_id || !meta.revision_id) throw new Error("법령 청킹에는 law_id·revision_id 필요");
  const lawName = meta.law_name ?? meta.title;
  const law = parseLaw(text, { law_id: meta.law_id, law_name: lawName, revision_id: meta.revision_id });
  const byId = new Map(law.provisions.map((p) => [p.provision_id, p]));
  const children = new Map<string, Provision[]>();
  for (const p of law.provisions) if (p.parent_id) children.set(p.parent_id, [...(children.get(p.parent_id) ?? []), p]);

  // 청크 단위 선택
  const units: Provision[] = [];
  for (const p of law.provisions) {
    if (p.level === "ANNEX") units.push(p);
    if (p.level !== "ARTICLE") continue;
    const paras = (children.get(p.provision_id) ?? []).filter((c) => c.level === "PARAGRAPH");
    if (!paras.length) { units.push(p); continue; }
    for (const para of paras) {
      const nodes = subtree(para, children);
      if (render(nodes, "original_text").length <= MAX_CHUNK_CHARS) { units.push(para); continue; }
      // 긴 항: 항 본문 + 호 단위로 분할 (상위 항 문맥은 헤더로 연결)
      units.push(para);
      for (const item of (children.get(para.provision_id) ?? [])) units.push(item);
    }
  }

  const splitLong = new Set(units.filter((u) => u.level === "ITEM").map((u) => u.parent_id));
  return units.map((u) => {
    const article = u.level === "ARTICLE" ? u : [...ancestors(u, byId)].find((a) => a.level === "ARTICLE");
    const nodes = u.level === "PARAGRAPH" && splitLong.has(u.provision_id) ? [u] : subtree(u, children);
    const original = render(nodes, "original_text");
    const normalized = render(nodes, "normalized_text");
    const header = [
      lawName,
      `시행 ${fmtDate(meta.effective_from)}`,
      ...u.heading_path,
      article ? `${article.path_label}${article.title ? `(${article.title})` : ""}` : undefined,
      u.level !== "ARTICLE" ? u.path_label : undefined,
      u.status === "DELETED" ? "삭제됨" : undefined,
    ].filter(Boolean).join(" · ");
    return {
      augmented_search_text: `[${header}]\n${normalized}`,
      metadata: {
        ...meta,
        provision_id: u.provision_id,
        provision_path: u.path_label,
        provision_status: u.status,
        parent_id: u.parent_id ?? meta.doc_id,
        source_page: pageOfLine(u.source_line),
        original_text: original,
      },
    };
  });
}

function* ancestors(p: Provision, byId: Map<string, Provision>) {
  let cur = p.parent_id ? byId.get(p.parent_id) : undefined;
  while (cur) { yield cur; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined; }
}

/** 노하우·매뉴얼 조각 나누기 (과천 매뉴얼 실측 11/18: OCR 본문에 "## 제목"이 없어 39쪽이 조각 1개, 근거가 늘 1쪽으로 잡힘).
 *  ① "## 제목" ② 쪽 경계 ③ 길이(MAX_CHUNK_CHARS)로 나눈다. 마크다운 표(| 로 시작하는 연속 줄)는 중간에서 자르지 않고,
 *  표 하나가 상한을 넘으면 머리행을 반복해 행 단위로 나눈다. 쪽 번호는 조각 첫 글자 줄의 쪽 */
export function chunkKnowledge(text: string, meta: DocumentMetadata, pageOfLine: (line: number) => number = () => 0): Chunk[] {
  const fm = /^---\n[\s\S]*?\n---\n/u.exec(text)?.[0] ?? "";
  const body = text.slice(fm.length); // front matter 제거
  const offset = fm ? fm.split("\n").length - 1 : 0;
  type Line = { t: string; page: number };
  const sections: { heading: string; lines: Line[] }[] = [];
  let cur: { heading: string; lines: Line[] } = { heading: meta.title, lines: [] };
  for (const [i, t] of body.split(/\r?\n/u).entries()) {
    const h = t.match(/^#{2,3}\s+(.+)$/u);
    if (h) { if (cur.lines.some((l) => l.t.trim())) sections.push(cur); cur = { heading: h[1]!.trim(), lines: [] }; continue; }
    if (/^#\s+/u.test(t)) continue; // 문서 제목은 헤더로
    cur.lines.push({ t, page: pageOfLine(offset + i + 1) });
  }
  if (cur.lines.some((l) => l.t.trim())) sections.push(cur);
  if (!sections.length) throw new Error("노하우 본문이 비어 있음");
  const kind = meta.document_type === "MANUAL" ? "매뉴얼" : "노하우";
  const pieces: { heading: string; lines: Line[] }[] = [];
  for (const sec of sections) for (const lines of splitLines(sec.lines)) pieces.push({ heading: sec.heading, lines });
  return pieces.map((pc, i) => {
    const t = pc.lines.map((l) => l.t).join("\n").trim();
    const page = pc.lines.find((l) => l.t.trim())?.page ?? 0;
    return {
      augmented_search_text: `[${meta.title} · ${kind} · ${pc.heading}]\n${t}`,
      metadata: {
        ...meta, provision_id: `${meta.doc_id}#s${i}`, provision_path: pc.heading, provision_status: "ACTIVE",
        parent_id: meta.doc_id, source_page: page, original_text: t,
      },
    };
  });
}

/** 줄 묶음을 쪽 경계·길이로 나눈다. 표 블록은 한 덩어리(넘치면 머리행 반복해 행 단위) */
function splitLines<L extends { t: string; page: number }>(lines: L[]): L[][] {
  // 단위: 표 블록(연속 | 줄) 또는 한 줄
  const units: L[][] = [];
  // 상한을 넘는 한 줄은 낱말 경계에서 여러 줄로 (PR #41 리뷰)
  const wrap = (l: L): L[] => {
    if (l.t.length <= MAX_CHUNK_CHARS) return [l];
    const out: L[] = []; let rest = l.t;
    while (rest.length > MAX_CHUNK_CHARS) { const cut = rest.slice(0, MAX_CHUNK_CHARS).replace(/\S*$/u, "") || rest.slice(0, MAX_CHUNK_CHARS); out.push({ ...l, t: cut.trimEnd() }); rest = rest.slice(cut.length).trimStart(); }
    if (rest) out.push({ ...l, t: rest });
    return out;
  };
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.t.trimStart().startsWith("|")) { for (const w of wrap(lines[i]!)) units.push([w]); continue; }
    let j = i; while (j < lines.length && lines[j]!.t.trimStart().startsWith("|")) j++;
    const table = lines.slice(i, j);
    const size = (u: L[]) => u.reduce((n, l) => n + l.t.length + 1, 0);
    if (size(table) <= MAX_CHUNK_CHARS) units.push(table);
    else { // 머리행(구분행이 있으면 함께) 반복, 행 단위
      const sep = /^\s*\|\s*:?-{3,}/u.test(table[1]?.t ?? "");
      const head = table.slice(0, sep ? 2 : 1); let part: L[] = [...head];
      for (const row of table.slice(head.length)) {
        if (size(part) + row.t.length + 1 > MAX_CHUNK_CHARS && part.length > head.length) { units.push(part); part = [...head]; }
        part.push(row);
      }
      if (part.length > head.length) units.push(part);
    }
    i = j - 1;
  }
  const out: L[][] = [];
  let cur: L[] = []; let len = 0;
  const flush = () => { if (cur.some((l) => l.t.trim())) out.push(cur); cur = []; len = 0; };
  for (const u of units) {
    const uLen = u.reduce((n, l) => n + l.t.length + 1, 0);
    const firstText = u.find((l) => l.t.trim());
    const curPage = cur.find((l) => l.t.trim())?.page;
    // 새 쪽이 시작되거나 길이를 넘으면 끊는다 (빈 줄만 있는 단위는 이어 붙임)
    if (cur.length && firstText && ((curPage !== undefined && firstText.page !== curPage) || len + uLen > MAX_CHUNK_CHARS)) flush();
    cur.push(...u); len += uLen;
  }
  flush();
  return out;
}


/** 장 나누기: 쪽 첫 글자 줄이 "04 …"·"04.…"처럼 두 자리 장 번호로 시작하고, 번호가 앞 장보다 클 때만 새 장 (10 이상은 앞 장 +2까지).
 *  "1. 다운로드"·"3 / 21"·"① …" 같은 단계·쪽 번호는 장이 아님 (PR #43 리뷰). 번호 없는 쪽(글자 없는 캡처 쪽 포함)은 앞 장을 잇는다.
 *  장 번호가 하나도 없는 문서는 장 없음.
 *  ponytail: 번호 붙은 장 표지가 있는 슬라이드형 매뉴얼 기준 (과천 실측). 다른 형식은 "## 제목" 절이 이미 조각 머리로 들어감 */
function sectionsOf(body: string[], pageAt: number[], lastPage: number): Map<number, { section: string; section_pages: string }> {
  const first = new Map<number, string>();
  body.forEach((l, i) => { const t = l.replace(/\f/gu, "").trim(); if (t && !first.has(pageAt[i]!)) first.set(pageAt[i]!, t); });
  const starts: { n: number; page: number; title: string }[] = [];
  const chapterOf = new Map<number, number>(); // 쪽 → starts 인덱스
  for (let p = 0; p <= lastPage; p++) {
    // 점이나 공백 필수 ("02-1234-5678" 전화번호 제외), 두 자리는 앞 장 +1·+2만 ("10. 설치" 단계가 장을 가로채지 않게)
    const m = /^(0[1-9]|[1-9]\d)(?:\.\s*|\s+)(\S.*)$/u.exec(first.get(p) ?? "");
    const n = Number(m?.[1]), prev = starts.at(-1)?.n ?? 0;
    if (m && n > prev && (m[1]!.startsWith("0") || n <= prev + 2)) starts.push({ n, page: p, title: [...`${m[1]} ${m[2]}`].slice(0, 60).join("") });
    if (starts.length) chapterOf.set(p, starts.length - 1);
  }
  const out = new Map<number, { section: string; section_pages: string }>();
  for (const [p, i] of chapterOf) {
    const end = (starts[i + 1]?.page ?? lastPage + 1) - 1;
    out.set(p, { section: starts[i]!.title, section_pages: `${starts[i]!.page + 1}-${end + 1}` });
  }
  return out;
}

/** Promote가 내는 그림 줄 접두 (@hanaeum/schemas 한 곳에서 정의) */
const CONTEXT_PREFIX = FIG_CONTEXT_LABEL;
const SUMMARY_RE = FIG_SUMMARY_RE;

/** 마스킹 흔적을 검색 텍스트에서 뺌: 자리 표시([개인정보]·[주민등록번호]… @hanaeum/pii, {LICENSE_PLATE} 같은 Guardrail 표기)와
 *  AI 그림 설명의 "가림 처리"·"가려져 있다" 문장. 가린 문서가 모두 "개인정보" 검색에 걸리던 문제 (사용자 지적 11/18). original_text·화면은 그대로
 *  ponytail: [고객번호]처럼 매뉴얼이 화면 항목을 대괄호로 쓴 정상 표기도 검색 텍스트에서는 빠짐 (마스킹 결과와 모양이 같음).
 *  구분하려면 @hanaeum/pii 자리 표시를 고유한 모양으로 바꿔야 함 (dhxorb96 협의) */
// 지금 가리지 않는 종류(전화번호·이메일·IP 주소, 사용자 결정 11/17 22시)도 이미 게시된 문서에 표시가 남아 있어 함께 지운다
const MASK_TOKEN = new RegExp(`\\[(?:개인정보|전화번호|이메일|IP 주소|${Object.values(PII_NAME).join("|")})\\]|\\{[A-Z][A-Z_]{2,}\\}`, "gu");
// 가림 흔적 문장 (좁게: "마스킹된 상태로 표시" 같은 실제 기능 설명은 남김, PR #44 리뷰)
const MASK_SENTENCE_KW = /가림\s*처리|가려(?:져|진|짐)\s*(?:있|박스|영역|칸)|\[개인정보\]\s*(?:로|으로)\s*가려/u;
// 그림 설명 "표기:" 목록에 괄호 없이 옮겨 적은 "개인정보" 칸 이름 (과천 실측 "/ 개인정보 / 개인정보 /")
const MASK_LABEL = /(?<=^|\/ |표기: |그림 \d+: )개인정보(?= \/|$| ›)/gmu;
/** 문장 단위로 나눠 키워드 든 문장만 버림 (줄 길이에 선형). 줄 머리 "쪽 정리(AI, 그림 기준): " 같은 접두는 남김 */
function dropMaskSentences(line: string): string {
  const pre = /^[^:\n]{1,40}: /u.exec(line)?.[0] ?? "";
  if (!MASK_SENTENCE_KW.test(line)) return line;
  return pre + line.slice(pre.length).split(/(?<=[.!?])\s+/u).filter((x) => !MASK_SENTENCE_KW.test(x)).join(" ");
}
export const stripMaskTrace = (s: string, figure = false) => {
  const t = figure ? s.split("\n").map(dropMaskSentences).join("\n").replace(MASK_LABEL, "") : s;
  return t.replace(MASK_TOKEN, "").replace(/\/(?:\s*\/)+/gu, "/").replace(/[ \t]{2,}/gu, " ");
};
const unmaskSearch = <T extends Chunk>(c: T): T => {
  const m = /^\[[^\]]*\]\n/u.exec(c.augmented_search_text); // 머리 [제목 · …]는 그대로
  const head = m?.[0] ?? "";
  const body = stripMaskTrace(c.augmented_search_text.slice(head.length), c.metadata.has_figure === true);
  return body.split("\n").some((l) => l.replace(/^[^:\n]{1,40}: /u, "").trim()) ? { ...c, augmented_search_text: head + body } : c; // 다 지워지면 원래대로 (머리만 남은 조각이 제목 질의에 유리해지지 않게)
};

/** 본문 끝의 그림 줄(⟦그림 pN⟧)은 본문 파싱에서 빼고 별도 청크로. 그림 설명·그림 속 글자는 인용 불가(original_text 비움),
 *  매뉴얼·노하우의 쪽 정리본은 그림 기준 근거(evidence_kind FIGURE, 인용 가능), 쪽 맥락은 같은 쪽 본문 조각의 머리로 */
export function chunkDocument(text: string, meta: DocumentMetadata): Chunk[] {
  return chunkDocument0(text, meta).map(unmaskSearch);
}

function chunkDocument0(text: string, meta: DocumentMetadata): Chunk[] {
  const body: string[] = []; const figs: { page: number; text: string }[] = []; const ctx = new Map<number, string>();
  for (const line of text.split("\n")) {
    const m = FIGURE_RE.exec(line);
    if (!m) { body.push(line); continue; }
    if (m[2]!.startsWith(`${CONTEXT_PREFIX}: `)) ctx.set(Number(m[1]), stripMaskTrace(m[2]!.slice(CONTEXT_PREFIX.length + 2), true)); // 쪽 맥락은 조각이 아니라 본문 조각의 머리로
    else figs.push({ page: Number(m[1]), text: m[2]! });
  }
  // 쪽 번호: Promote가 넣은 쪽 경계(\f 한 줄). \f만 지우고 줄 수는 그대로 두어, 조문·절이 시작하는 줄의 쪽을 쓴다
  // (반복되는 머리말·목차와 글자가 같아도 위치로 정하므로 앞쪽에 잘못 붙지 않음, PR #37 리뷰)
  const pageAt: number[] = [];
  let pg = 0;
  for (const l of body) { pageAt.push(pg); if (l.includes("\f")) pg++; }
  const pageOfLine = (ln: number) => pageAt[Math.min(Math.max(ln - 1, 0), pageAt.length - 1)] ?? 0;
  const clean = body.join("\n").replace(/\f/gu, "");
  const reg = meta.document_type === "REGULATION";
  const main0 = reg ? chunkLegal(clean, meta, pageOfLine) : chunkKnowledge(clean, meta, pageOfLine);
  const sec = reg ? new Map<number, { section: string; section_pages: string }>() : sectionsOf(body, pageAt, Math.max(pageAt.at(-1) ?? 0, ...figs.map((f) => f.page)));
  const withSec = <T extends Chunk>(c: T): T => { const s = sec.get(c.metadata.source_page); return s ? { ...c, metadata: { ...c.metadata, ...s } } : c; };
  // 본문 조각에 같은 쪽 맥락을 검색 머리(두 번째 줄)와 page_context로 붙임. original_text(인용)는 그대로
  const main = reg ? main0 : main0.map(withSec).map((c) => {
    const pc = ctx.get(c.metadata.source_page);
    if (!pc) return c;
    const m = /^\[[^\]]*\]\n/u.exec(c.augmented_search_text);
    const head = m?.[0] ?? "";
    return { augmented_search_text: `${head}[쪽 맥락 · 그림 기준(AI)] ${pc}\n${c.augmented_search_text.slice(head.length)}`, metadata: { ...c.metadata, page_context: pc } };
  });
  return [...main, ...figs.map((f, i) => {
    // 매뉴얼·노하우의 쪽 정리본은 그림 기준 근거로 인용 가능 (사용자 요구: 화면 캡처 절차까지, yoyo0704 결정 11/18). 규정·그림 속 글자는 인용 불가
    const summary = !reg && SUMMARY_RE.test(f.text) && !!f.text.replace(SUMMARY_RE, "").trim();
    return {
      augmented_search_text: `[${meta.title} · 그림 (${f.page + 1}쪽)]\n${f.text}`,
      metadata: { ...meta, provision_id: `${meta.doc_id}#fig${i}`, provision_path: `그림 (${f.page + 1}쪽)`, provision_status: "ACTIVE" as const,
        parent_id: meta.doc_id, source_page: f.page, original_text: summary ? f.text.replace(SUMMARY_RE, "") : "", has_figure: true,
        ...(summary ? { evidence_kind: "FIGURE" as const } : {}), ...(ctx.get(f.page) ? { page_context: ctx.get(f.page)! } : {}) },
    };
  }).map(withSec)];
}
