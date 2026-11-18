// 노하우 본문 → 인용 조문 후보 (CITES 후보). 후보일 뿐이며 사람 승인 후에만 그래프에 게시한다.
// 규칙: 법령명이 언급되면 이후의 "제N조…"는 그 법령으로, 명시 시행본 날짜가 있으면 그 버전, 없으면 기준일 시행 버전.
import { FIGURE_RE, SUBITEM_CODES } from "@hanaeum/schemas";
import type { SubitemChar } from "@hanaeum/schemas";
import type { ClauseStore } from "@hanaeum/regulation-server";
import type { Citation } from "./model.ts";

// 괄호는 「」 외에 『』 [ ] 《》 〈〉 도 (OCR이 「」를 [ ]로 읽는 경우, 사용자 지적 11/18)
const LAW_MENTION = /[「『[《〈]?([가-힣][가-힣\s]*?(?:규정|법|시행령|시행규칙|지침|세칙))[」』\]》〉]?(?=\s*(?:\d{4}\.|제\s*\d+\s*조|\(|$|[,.]))/gu;
const CLAUSE = /제(\d+)조(?:의(\d+))?(?:제(\d+)항)?(?:제(\d+)호(?:의(\d+))?)?(?:([가-하])목)?/gu;
const DATE_NEAR = /(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.\s*시행본/u;

export async function extractCitations(text: string, store: ClauseStore, asOf: number): Promise<Citation[]> {
  // 그림 설명·그림 속 글자·AI 쪽 정리(⟦그림 pN⟧ 줄)는 원문이 아니므로 인용 근거로 쓰지 않는다 (PR #38 리뷰)
  const body = text.replace(/^---\n[\s\S]*?\n---\n/u, "").split("\n").filter((l) => !FIGURE_RE.test(l)).join("\n");
  const events: { at: number; law?: string; date?: number; clause?: RegExpMatchArray }[] = [];
  for (const m of body.matchAll(LAW_MENTION)) {
    const id = await store.lawIdByName(m[1]!.trim());
    if (id) {
      const d = body.slice(m.index!, m.index! + m[0].length + 25).match(DATE_NEAR);
      events.push({ at: m.index!, law: id, ...(d ? { date: Number(`${d[1]}${d[2]!.padStart(2, "0")}${d[3]!.padStart(2, "0")}`) } : {}) });
    }
  }
  for (const m of body.matchAll(CLAUSE)) events.push({ at: m.index!, clause: m });
  events.sort((a, b) => a.at - b.at);

  const out = new Map<string, Citation>();
  let law: string | undefined; let date: number | undefined;
  for (const e of events) {
    if (e.law) { law = e.law; date = e.date; continue; }
    if (!law || !e.clause) continue;
    const revs = await store.revisions(law);
    const ymd = date ?? asOf;
    const rev = revs.find((r) => r.effective_from <= ymd && ymd <= r.effective_to);
    if (!rev) continue;
    const [raw, a, ab, p, i, ib, s] = e.clause;
    let id = `${law}@${rev.revision_id}/ARTICLE:${a}${ab ? `-${ab}` : ""}`;
    if (p) id += `/PARAGRAPH:${p}`;
    if (i) id += `/ITEM:${i}${ib ? `-${ib}` : ""}`;
    if (s) id += `/SUBITEM:${SUBITEM_CODES[s as SubitemChar]}`;
    const line = body.slice(body.lastIndexOf("\n", e.at) + 1, body.indexOf("\n", e.at) === -1 ? undefined : body.indexOf("\n", e.at)).trim();
    const provs = await store.provisions(law, rev.revision_id);
    const exists = !!provs?.some((x) => x.provision_id === id);
    out.set(id, { provision_id: id, evidence_span: line.slice(0, 300) || raw!, confidence: exists ? 0.9 : 0.3 });
  }
  return [...out.values()];
}
