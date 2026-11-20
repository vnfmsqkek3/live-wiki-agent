// AgentCore Browser로 공개 웹 페이지 읽기 (docs/01 540행: 내부 인덱스·공식 API 우선, Browser는 보조 수단).
// - 법령 원문(fetch_official_law): 허용 호스트는 국가법령정보센터 하나. 입력은 법령명만 받고 URL은 코드가 만든다.
// - 범용 readPage(참조 확인, interfaces 6.4): http(s)만, 내부 주소(IP 리터럴·localhost·사설 이름) 거부, allowHosts로 더 좁힐 수 있음.
//   방어선은 AWS 관리형 샌드박스(공개 모드)다. DNS·리다이렉트 우회는 여기서 완전히 막지 못한다.
// 결과는 신뢰할 수 없는 입력(UNVERIFIED): 게시 근거·VERIFIED 판정에 쓰지 않고, 모델에 넘길 때는 지시문 검사를 거친다.
import WebSocket from "ws";
import { Browser } from "bedrock-agentcore/browser";
import { parseLaw, diffLaws } from "@hanaeum/legal-parser";
import { isoFromDotted, isoOfYmd, ymd } from "@hanaeum/schemas";
import type { ClauseStore } from "./store.ts";
import { relPath } from "./store.ts";
import { clausePath } from "./clause.ts";

export const LAW_SITE = "https://www.law.go.kr";
const CDP_TIMEOUT_MS = 15_000;
/** 세션 timeout(120초) 안에서만 기다린다 */
const MAX_WAIT_SEC = 100;

/** 열어도 되는 주소인지: http(s), 내부 주소 아님, allowHosts가 있으면 그 안. 아니면 BlockedUrl */
export function checkUrl(url: string, allowHosts?: string[]): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw Object.assign(new Error("주소 형식이 올바르지 않음"), { name: "BlockedUrl" }); }
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const internal = /^(localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/u.test(h) || /^\d{1,3}(\.\d{1,3}){3}$/u.test(h) || h.includes(":") || !h.includes(".");
  if (!["http:", "https:"].includes(u.protocol) || internal) throw Object.assign(new Error(`열 수 없는 주소: ${u.protocol}//${h}`), { name: "BlockedUrl" });
  if (allowHosts && !allowHosts.some((a) => h === a || h.endsWith(`.${a}`))) throw Object.assign(new Error(`허용 목록 밖 호스트: ${h}`), { name: "BlockedUrl" });
  return u;
}
// 행정규칙(고시·훈령·예규·지침, "외국환거래규정")은 /행정규칙/ 경로 (/법령/은 빈 안내 쪽, 11/20 확인)
// ponytail: 이름 끝으로 판정. "~규정"인 대통령령(예 공무원보수규정)은 잘못 고르므로 그런 인용이 생기면 /법령/ 재시도 추가
const ADMIN_RULE = /(?:규정|고시|훈령|예규|지침)$/u;
export const lawUrl = (lawName: string) => `${LAW_SITE}/${ADMIN_RULE.test(lawName.trim()) ? "행정규칙" : "법령"}/${encodeURIComponent(lawName.trim())}`;

export interface LawPage { url: string; header: string; body: string; fetched_at?: string; from_cache?: boolean }
export interface LawPageFetcher { fetch(lawName: string): Promise<LawPage> }

/** 분석 단계 판단: 본문이 인용한 「법령명」 중 내부 규정 저장소에 없는 외부 법령. 비어 있으면 Browser를 돌리지 않는다.
 *  ponytail: 「」로 감싼 이름만 인식 (법제처 표기 규칙). 괄호 없는 "개인정보 보호법 제15조"는 이름 범위를 추정하다 헛조회(약 30초)가 나므로 의도적으로 제외 */
// 법령명 괄호: 「」 외에 OCR·작성자가 쓰는 『』 [ ] 《》 〈〉 도 (사용자 지적 11/18: "[개인정보 보호법]제15조제1항"이 외부 법령에 안 나옴)
// ponytail: 괄호 없는 "개인정보 보호법 제15조"는 앞 낱말과 경계가 모호해 제외 (예 "근거하여 은행법")
// 괄호 짝이 달라도 허용 (OCR이 한쪽만 다르게 읽는 경우). [ ]《》〈〉는 소제목에 흔해 바로 뒤에 조문 표기가 있을 때만 (PR #47 리뷰)
// 조문 표기: 제12조, 제12조의2, 가지번호 제9-5조(행정규칙), 뒤 제n항
const CLAUSE = String.raw`제\s*\d+(?:\s*-\s*\d+)?\s*조(?:\s*의\s*\d+)?(?:\s*제\s*\d+\s*항)?(?:\s*제\s*\d+\s*호(?:\s*의\s*\d+)?(?:\s*[·,]\s*제\s*\d+\s*호(?:\s*의\s*\d+)?)*)?`; // 호 목록 "제8호·제9호"까지 (API가 조·항 아래 sub로 묶음)
const LAW_REF = new RegExp(String.raw`([「『[《〈])\s*([^」』\]》〉\n]{2,40}?)\s*[」』\]》〉]\s*(${CLAUSE})?`, "gu");
// 괄호 없는 이름: 줄 첫머리나 여는 괄호 바로 뒤의 띄어쓰기 없는 한 낱말 + 조문 표기만 (사용자 문서 11/20 "(외국환거래규정 제9-5조제1항)").
// ponytail: 앞 낱말과 경계가 모호한 "근거하여 은행법 제5조"·"개인정보 보호법 제15조"는 여전히 제외 → API Haiku 추출이 보완
const BARE_REF = new RegExp(String.raw`(?:^|(?<=[(（]))\s*()([\p{Script=Hangul}A-Za-z0-9·]{2,40})\s*(${CLAUSE})`, "gmu");
// 법령명 끝: 법·법률·시행령·규칙·규정·…령. "방법"·"요령"·"명령"은 제외
// 괄호 없는 이름 중 지시어·일반 명칭("동법"·"같은법"·"본규정"·"시행령"·"규정")은 법령명이 아님 (PR #75 데이터QA 리뷰). "이자제한법"처럼 접두어만 같은 실제 법령은 유지
const DEICTIC = /^(?:동|같은|본|이|당|당행|본행|위|해당|상기)?\s*(?:법|법률|규정|규칙|시행령|시행규칙|령)$/u;
const LAW_NAME_END = /(?<!방)법$|법률$|시행령$|(?<![요명])령$|규칙$|규정$/u; // 규정: 외국환거래규정 같은 행정규칙(고시). 내부 규정은 저장소에 있어 빠짐
// 법령명 없이 줄 첫머리·여는 괄호 바로 뒤에 온 조문 "(제9-5조제3항)" → 본문에서 바로 앞에 나온 법령의 조문 (문장 가운데 "제5조에 따라"는 대상 아님)
const BARE_CLAUSE = new RegExp(String.raw`(?:^|(?<=[(（]))\s*(${CLAUSE})`, "gmu");
export interface ExternalLawRef { law_name: string; /** 첫 조문 (하위 호환) */ clause?: string; /** 본문 인용 조문 전부, 나온 순서·중복 제거, 호 목록은 호마다 (11/20) */ clauses: string[] }
/** 본문이 인용한 외부 법령(내부 규정 저장소에 없는 것)과 인용 조문 (법령 최대 max개, 법령당 조문 최대 10개) */
export async function externalLawRefs(text: string, store: ClauseStore, max = 5): Promise<ExternalLawRef[]> {
  const named: { at: number; end: number; name: string; clause?: string }[] = [];
  for (const m of [...text.matchAll(LAW_REF), ...text.matchAll(BARE_REF)]) {
    const n = m[2]!.replace(/\s+/gu, " ").trim();
    if (!LAW_NAME_END.test(n)) continue; // 법령명만 (서식·문서명·"신청 방법" 제외)
    if (!"「『".includes(m[1]!) && !m[3]) continue; // [ ]·《》·〈〉·괄호 없음은 조문 표기가 있을 때만
    if (DEICTIC.test(n)) continue;
    named.push({ at: m.index, end: m.index + m[0].length, name: n, ...(m[3] ? { clause: m[3] } : {}) });
  }
  named.sort((a, b) => a.at - b.at);
  const refs = [...named];
  for (const m of text.matchAll(BARE_CLAUSE)) {
    if (named.some((x) => m.index >= x.at && m.index < x.end)) continue; // 이미 법령명과 함께 잡힌 조문
    const prev = named.filter((x) => x.at < m.index).at(-1);
    if (prev) refs.push({ at: m.index, end: m.index, name: prev.name, clause: m[1]! });
  }
  refs.sort((a, b) => a.at - b.at);
  const seen = new Map<string, string[]>();
  for (const r of refs) {
    const list = seen.get(r.name) ?? [];
    // "제9-9조제1항제8호·제9호" → 호마다 나눔 (clausePath·fetch_official_law가 해석 가능한 표기만, AI팀 요청 11/20)
    const c = r.clause?.replace(/\s+/gu, "");
    const [head, ...items] = c ? c.split(/[·,]/u) : [];
    const base = head?.replace(/제\d+호(?:의\d+)?$/u, "");
    for (const x of head ? [head, ...items.map((i) => base + i)] : []) if (!list.includes(x) && list.length < 10) list.push(x);
    seen.set(r.name, list);
  }
  const out: ExternalLawRef[] = [];
  for (const [n, cs] of seen) if (out.length < max && !(await store.lawIdByName(n))) out.push({ law_name: n, ...(cs[0] ? { clause: cs[0] } : {}), clauses: cs });
  return out;
}
export async function externalLaws(text: string, store: ClauseStore, max = 5): Promise<string[]> {
  return (await externalLawRefs(text, store, max)).map((r) => r.law_name);
}

/** 같은 법령을 다시 열 때 Browser 재실행을 막는 캐시 (기본 1일) */
export interface LawPageCache { get(lawName: string): Promise<(LawPage & { fetched_at: string }) | undefined>; put(lawName: string, page: LawPage, fetchedAt: string): Promise<void> }
export const CACHE_MS = 24 * 3600 * 1000;
/** 호출마다 결과에 조회 시각·캐시 여부를 담아 돌려준다 (공유 상태 없음 → 여러 법령 동시 조회 안전) */
export function cachedFetcher(inner: LawPageFetcher, cache: LawPageCache, now = () => new Date()): LawPageFetcher {
  return {
    async fetch(lawName) {
      // 캐시 읽기 실패도 캐시 없음으로 (조회는 Browser 로 계속, 데이터QA 리뷰 #110)
      const hit = await cache.get(lawName).catch((e: Error) => { console.warn(JSON.stringify({ msg: "법령 원문 캐시 읽기 실패", law: lawName, error: e.name })); return undefined; });
      if (hit && now().getTime() - Date.parse(hit.fetched_at) < CACHE_MS) return { url: hit.url, header: hit.header, body: hit.body, fetched_at: hit.fetched_at, from_cache: true };
      const page = await inner.fetch(lawName);
      const fetched_at = now().toISOString();
      // 캐시 저장 실패(항목 크기·스로틀링)는 조회 실패가 아니다: 가져온 원문은 그대로 돌려준다 (prod 11/20 전 조문 '원문 조회 실패')
      await cache.put(lawName, { url: page.url, header: page.header, body: page.body }, fetched_at)
        .catch((e: Error) => console.warn(JSON.stringify({ msg: "법령 원문 캐시 저장 실패", law: lawName, error: e.name, chars: page.body.length })));
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
  // 명령마다 시간 제한 (페이지 스크립트가 멈추거나 연결이 끊겨도 영원히 기다리지 않게)
  return (method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = CDP_TIMEOUT_MS) =>
    new Promise<Record<string, unknown>>((ok, ng) => {
      const n = ++id;
      const t = setTimeout(() => { pending.delete(n); ng(Object.assign(new Error(`CDP ${method} 시간 초과`), { name: "CdpTimeout" })); }, timeoutMs);
      pending.set(n, { ok: (v) => { clearTimeout(t); ok(v); }, ng: (e) => { clearTimeout(t); ng(e); } });
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
}

/** AgentCore 관리형 Browser(aws.browser.v1)로 페이지 하나를 열어 `expression`(브라우저에서 평가, 문자열 반환)이 `done`을 만족할 때까지
 *  1초 간격으로 읽는다. 세션은 매 호출 열고 닫는다. 법령 원문 조회와 참조 확인(dhxorb96, interfaces 6.4)이 같이 쓴다.
 *  ponytail: 호출마다 세션 1개 (재사용 풀 없음). 동시 호출이 많아지면 세션 풀 */
export async function readPage(url: string, o: { expression: string; done: (value: string) => boolean; maxWaitSec?: number; region?: string; identifier?: string; sessionName?: string; allowHosts?: string[] }): Promise<string> {
  const u = checkUrl(url, o.allowHosts); // 세션을 열기 전에 주소부터 검사
  const wait = Math.min(Math.max(Math.floor(o.maxWaitSec ?? 30), 1), MAX_WAIT_SEC);
  const id = o.identifier ?? process.env["BROWSER_ID"];
  const b = new Browser({ region: o.region ?? process.env["AWS_REGION"] ?? "us-east-1", ...(id ? { identifier: id } : {}) });
  await b.startSession({ sessionName: o.sessionName ?? "hanaeum-read", timeout: 120 });
  let ws: WebSocket | undefined;
  try {
    const { url: wsUrl, headers } = await b.generateWebSocketUrl();
    ws = new WebSocket(wsUrl, { headers });
    await new Promise((ok, ng) => { ws!.once("open", ok); ws!.once("error", ng); });
    const send = cdp(ws);
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string };
    await send("Page.navigate", { url: u.href }, sessionId);
    let last = "";
    for (let i = 0; i < wait; i++) {
      const r = await send("Runtime.evaluate", { expression: o.expression, returnByValue: true }, sessionId) as { result: { value?: unknown } };
      last = typeof r.result.value === "string" ? r.result.value : "";
      if (o.done(last)) return last;
      await new Promise((res) => setTimeout(res, 1000));
    }
    const err = Object.assign(new Error(`페이지 내용을 기다리다 시간 초과: ${u.host}`), { name: "PageNotReady" });
    // 마지막으로 읽은 내용은 앞부분만, 열거되지 않게 (로그에 페이지 전문이 찍히지 않게)
    Object.defineProperty(err, "last", { value: last.slice(0, 500), enumerable: false });
    throw err;
  } finally {
    ws?.close();
    // 세션 종료 실패가 결과나 원래 오류를 덮지 않게 (세션은 timeout으로도 닫힘)
    await b.stopSession().catch((e: unknown) => console.warn(JSON.stringify({ msg: "Browser 세션 종료 실패", error: (e as Error).name })));
  }
}

/** 법령 원문 페이지 (law.go.kr): 본문에 "제1조"가 그려질 때까지 */
export class AgentCoreLawFetcher implements LawPageFetcher {
  private readonly region: string;
  private readonly identifier: string | undefined;
  constructor(region = process.env["AWS_REGION"] ?? "us-east-1", identifier = process.env["BROWSER_ID"]) { this.region = region; this.identifier = identifier; }
  async fetch(lawName: string): Promise<LawPage> {
    const url = lawUrl(lawName);
    try {
      // ponytail: 사이트 구조 변경 시 선택자 갱신
      const v = JSON.parse(await readPage(url, {
        expression: `JSON.stringify({ h: document.querySelector("#conTop")?.innerText ?? "", b: document.querySelector("#conScroll")?.innerText ?? "" })`,
        done: (x) => /제1조/u.test((JSON.parse(x || "{}") as { b?: string }).b ?? ""),
        region: this.region, ...(this.identifier ? { identifier: this.identifier } : {}), sessionName: "hanaeum-law", allowHosts: ["www.law.go.kr"],
      })) as { h?: string; b?: string };
      return { url, header: v.h ?? "", body: v.b ?? "" };
    } catch (e) {
      if ((e as Error).name === "PageNotReady") throw Object.assign(new Error(`법령 본문을 찾지 못함: ${lawName}`), { name: "LawPageNotFound" });
      throw e;
    }
  }
}

/** "[시행 2026. 7. 1.] [법률 제21296호, 2025. 12. 30., 일부개정]" */
export function parseHeader(h: string) {
  const eff = /\[시행\s*(\d{4}\.\s*\d{1,2}\.\s*\d{1,2})\.?\]/u.exec(h);
  const no = /\[([^\]]*제\d+(?:-\d+)?호)[^\]]*\]/u.exec(h); // 고시 번호 "제2025-12호"
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

const iso = isoOfYmd;

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
    let path: string | undefined;
    try { path = clausePath(a.clause); } catch { path = undefined; } // 해석 불가 표현이면 clause=null
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
