// AgentCore Browser로 최신 공식 법령 원문 참조 (docs/01 540행: 내부 인덱스·공식 API 우선, Browser는 허용 사이트 한정 보조 수단).
// 허용 사이트는 국가법령정보센터 하나. 입력은 법령명만 받고 URL은 코드가 만든다 (임의 URL 접근 차단).
// 결과는 참고용(UNVERIFIED): Trusted Registry·승인을 거치지 않았으므로 게시 근거나 VERIFIED 판정에 쓰지 않는다.
import WebSocket from "ws";
import { Browser } from "bedrock-agentcore/browser";
import { parseLaw, diffLaws } from "@hanaeum/legal-parser";
import { isoFromDotted, ymd } from "@hanaeum/schemas";
import type { ClauseStore } from "./store.ts";
import { relPath } from "./store.ts";

export const LAW_SITE = "https://www.law.go.kr";
export const lawUrl = (lawName: string) => `${LAW_SITE}/법령/${encodeURIComponent(lawName.trim())}`;

export interface LawPage { url: string; header: string; body: string; fetched_at?: string; from_cache?: boolean }
export interface LawPageFetcher { fetch(lawName: string): Promise<LawPage> }

/** 분석 단계 판단: 본문이 인용한 「법령명」 중 내부 규정 저장소에 없는 외부 법령. 비어 있으면 Browser를 돌리지 않는다.
 *  ponytail: 「」로 감싼 이름만 인식 (법제처 표기 규칙). 괄호 없는 "개인정보 보호법 제15조"는 이름 범위를 추정하다 헛조회(약 30초)가 나므로 의도적으로 제외 */
export async function externalLaws(text: string, store: ClauseStore, max = 5): Promise<string[]> {
  const names = [...new Set([...text.matchAll(/「([^」\n]{2,40}?)」/gu)].map((m) => m[1]!.replace(/\s+/gu, " ").trim()))]
    .filter((n) => /(법|법률|령|규칙)$/u.test(n)); // 법령명만 (서식·문서명 제외)
  const out: string[] = [];
  for (const n of names) if (!(await store.lawIdByName(n)) && out.length < max) out.push(n);
  return out;
}

/** 같은 법령을 다시 열 때 Browser 재실행을 막는 캐시 (기본 1일) */
export interface LawPageCache { get(lawName: string): Promise<(LawPage & { fetched_at: string }) | undefined>; put(lawName: string, page: LawPage, fetchedAt: string): Promise<void> }
export const CACHE_MS = 24 * 3600 * 1000;
/** 호출마다 결과에 조회 시각·캐시 여부를 담아 돌려준다 (공유 상태 없음 → 여러 법령 동시 조회 안전) */
export function cachedFetcher(inner: LawPageFetcher, cache: LawPageCache, now = () => new Date()): LawPageFetcher {
  return {
    async fetch(lawName) {
      const hit = await cache.get(lawName);
      if (hit && now().getTime() - Date.parse(hit.fetched_at) < CACHE_MS) return { url: hit.url, header: hit.header, body: hit.body, fetched_at: hit.fetched_at, from_cache: true };
      const page = await inner.fetch(lawName);
      const fetched_at = now().toISOString();
      await cache.put(lawName, { url: page.url, header: page.header, body: page.body }, fetched_at);
      return { ...page, fetched_at, from_cache: false };
    },
  };
}

/** CDP 최소 클라이언트: 명령 id로 응답을 짝짓는다 */
function cdp(ws: WebSocket) {
  let id = 0;
  const pending = new Map<number, { ok: (v: Record<string, unknown>) => void; ng: (e: Error) => void }>();
  ws.on("message", (raw) => {
    const m = JSON.parse(String(raw)) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
    const p = m.id === undefined ? undefined : pending.get(m.id);
    if (!p) return;
    pending.delete(m.id!);
    if (m.error) p.ng(new Error(`CDP ${m.error.message}`)); else p.ok(m.result ?? {});
  });
  return (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<Record<string, unknown>>((ok, ng) => {
      const n = ++id;
      pending.set(n, { ok, ng });
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
}

/** AgentCore 관리형 Browser(aws.browser.v1) 세션 → SigV4 서명 WebSocket(CDP)으로 페이지 텍스트 추출. 세션은 매 호출 종료 */
export class AgentCoreLawFetcher implements LawPageFetcher {
  private readonly region: string;
  private readonly identifier: string | undefined;
  constructor(region = process.env["AWS_REGION"] ?? "us-east-1", identifier = process.env["BROWSER_ID"]) { this.region = region; this.identifier = identifier; }
  async fetch(lawName: string): Promise<LawPage> {
    const url = lawUrl(lawName);
    const b = new Browser({ region: this.region, ...(this.identifier ? { identifier: this.identifier } : {}) });
    await b.startSession({ sessionName: "hanaeum-law", timeout: 120 });
    let ws: WebSocket | undefined;
    try {
      const { url: wsUrl, headers } = await b.generateWebSocketUrl();
      ws = new WebSocket(wsUrl, { headers });
      await new Promise((ok, ng) => { ws!.once("open", ok); ws!.once("error", ng); });
      const send = cdp(ws);
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string };
      await send("Page.navigate", { url }, sessionId);
      // ponytail: 본문이 그려질 때까지 1초 간격 폴링(최대 30초). 사이트 구조 변경 시 선택자 갱신
      for (let i = 0; i < 30; i++) {
        const r = await send("Runtime.evaluate", {
          expression: `JSON.stringify({ h: document.querySelector("#conTop")?.innerText ?? "", b: document.querySelector("#conScroll")?.innerText ?? "" })`,
          returnByValue: true,
        }, sessionId) as { result: { value?: string } };
        const v = JSON.parse(r.result.value ?? "{}") as { h?: string; b?: string };
        if (v.b && /제1조/u.test(v.b)) return { url, header: v.h ?? "", body: v.b };
        await new Promise((res) => setTimeout(res, 1000));
      }
      throw Object.assign(new Error(`법령 본문을 찾지 못함: ${lawName}`), { name: "LawPageNotFound" });
    } finally {
      ws?.close();
      await b.stopSession();
    }
  }
}

/** "[시행 2026. 7. 1.] [법률 제21296호, 2025. 12. 30., 일부개정]" */
export function parseHeader(h: string) {
  const eff = /\[시행\s*(\d{4}\.\s*\d{1,2}\.\s*\d{1,2})\.?\]/u.exec(h);
  const no = /\[([^\]]*제\d+호)[^\]]*\]/u.exec(h);
  return { effective_from: eff ? isoFromDotted(eff[1]!) : undefined, promulgation: no?.[1] };
}

export interface OfficialLawResult {
  law_name: string; source: string; url: string; fetched_at: string; from_cache: boolean;
  effective_from?: string; promulgation?: string;
  authority_status: "UNVERIFIED"; note: string;
  provision_count: number; parse_issues: number;
  clause?: { path: string; text: string } | null;
  /** 저장소(Regulations)에 같은 법령이 있으면 최신 저장본과 비교 */
  stored?: { law_id: string; revision_id: string; effective_from: string; newer_official: boolean; changed: number; added: number; removed: number; changed_paths: string[] };
}

const iso = (n: number) => `${String(n).slice(0, 4)}-${String(n).slice(4, 6)}-${String(n).slice(6, 8)}`;

/** clause 예: "제2조", "제2조제1항" → 경로 ARTICLE:2/PARAGRAPH:1 와 대조 */
const clausePath = (c: string) => {
  const m = /^제(\d+)조(?:의(\d+))?(?:제(\d+)항)?(?:제(\d+)호)?$/u.exec(c.replace(/\s/gu, ""));
  if (!m) return undefined;
  return [`ARTICLE:${m[1]}${m[2] ? `-${m[2]}` : ""}`, m[3] && `PARAGRAPH:${m[3]}`, m[4] && `ITEM:${m[4]}`].filter(Boolean).join("/");
};

export async function fetchOfficialLaw(fetcher: LawPageFetcher, store: ClauseStore, a: { law_name: string; clause?: string }, now = () => new Date()): Promise<OfficialLawResult> {
  const page = await fetcher.fetch(a.law_name);
  const { effective_from, promulgation } = parseHeader(page.header);
  const rev = effective_from ?? "unknown";
  const law = parseLaw(page.body, { law_id: "WEB", law_name: a.law_name, revision_id: rev, ...(effective_from ? { effective_from: ymd(effective_from) } : {}) });
  const out: OfficialLawResult = {
    law_name: a.law_name, source: "국가법령정보센터 (AgentCore Browser)", url: page.url, fetched_at: page.fetched_at ?? now().toISOString(),
    from_cache: page.from_cache === true,
    ...(effective_from ? { effective_from } : {}), ...(promulgation ? { promulgation } : {}),
    authority_status: "UNVERIFIED", note: "외부 공식 사이트 원문 참고용. Registry 등록·승인 전에는 게시·검증 근거로 쓰지 않음",
    provision_count: law.provisions.length, parse_issues: law.issues.length,
  };
  if (a.clause) {
    const path = clausePath(a.clause);
    // 조·항 단위 요청이면 하위 항·호·목 원문까지 이어 붙인다
    const ps = path ? law.provisions.filter((x) => { const r = relPath(x.provision_id); return r === path || r.startsWith(`${path}/`); }) : [];
    out.clause = ps.length ? { path: path!, text: ps.map((x) => `${x.original_marker}${x.title ? `(${x.title})` : ""} ${x.original_text}`.trim()).join("\n") } : null;
  }
  const lawId = await store.lawIdByName(a.law_name);
  const latest = lawId ? (await store.revisions(lawId)).sort((x, y) => y.effective_from - x.effective_from)[0] : undefined;
  const provs = latest && await store.provisions(latest.law_id, latest.revision_id);
  if (latest && provs) {
    const d = diffLaws({ law_id: latest.law_id, law_name: latest.law_name, revision_id: latest.revision_id, effective_from: latest.effective_from, parser_version: "", provisions: provs, issues: [] }, law);
    out.stored = {
      law_id: latest.law_id, revision_id: latest.revision_id, effective_from: iso(latest.effective_from),
      newer_official: !!effective_from && ymd(effective_from) > latest.effective_from,
      changed: d.filter((c) => c.kind === "MODIFIED" || c.kind === "DELETED").length, added: d.filter((c) => c.kind === "ADDED").length, removed: d.filter((c) => c.kind === "REMOVED").length,
      changed_paths: d.map((c) => c.path).slice(0, 20),
    };
  }
  return out;
}
