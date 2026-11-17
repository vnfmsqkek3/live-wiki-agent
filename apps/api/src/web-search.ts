// 공개 웹 검색 (ReferenceCheck, interfaces 6.4). AgentCore 관리형 Browser(aws.browser.v1) 세션 → SigV4 WebSocket(CDP).
// 검색은 Google(관련도 가장 좋음) → 결과가 없으면(사람 확인 등) Bing. DuckDuckGo 는 자동 접속에 사람 확인을 띄워 쓰지 않음(11/18 실측).
// 결과 링크는 검색 엔진 경유 주소라 브라우저로 열어 도착한 실제 주소·제목·본문 일부를 읽는다. 웹 글은 자료로만 쓴다.
// 참고: let522mj mcp/regulation-server/src/browser.ts 와 같은 방식. 세션은 호출마다 연다(문서당 1세션, 최대 5건)
import WebSocket from 'ws';
import { Browser } from 'bedrock-agentcore/browser';
import { isCommunity, resultUrl } from './steps/reference-check.ts';

export interface WebHit { url: string; title: string; text: string }
/** 검색어 → 공식 사이트 추정(있으면 그 사이트부터 site: 검색) */
export interface WebSearcher { search(queries: string[], officialSites?: Map<string, string>): Promise<Map<string, WebHit[]>> }

function cdp(ws: WebSocket) {
  let id = 0;
  const pending = new Map<number, { ok: (v: Record<string, unknown>) => void; ng: (e: Error) => void }>();
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw)) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
    const p = m.id === undefined ? undefined : pending.get(m.id);
    if (!p) return;
    pending.delete(m.id!);
    if (m.error) p.ng(new Error(`CDP ${m.error.message}`)); else p.ok(m.result ?? {});
  });
  return (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<Record<string, unknown>>((ok, ng) => {
    const n = ++id; pending.set(n, { ok, ng }); ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AgentCoreWebSearcher implements WebSearcher {
  private readonly region: string;
  private readonly identifier: string | undefined;
  private readonly perQuery: number;
  constructor(region = process.env.AWS_REGION ?? 'us-east-1', identifier = process.env.BROWSER_ID, perQuery = 3) { this.region = region; this.identifier = identifier; this.perQuery = perQuery; }
  async search(queries: string[], officialSites: Map<string, string> = new Map()) {
    const out = new Map<string, WebHit[]>();
    if (!queries.length) return out;
    const b = new Browser({ region: this.region, ...(this.identifier ? { identifier: this.identifier } : {}) });
    await b.startSession({ sessionName: 'hanaeum-refcheck', timeout: 300 });
    let ws: WebSocket | undefined;
    try {
      const { url: wsUrl, headers } = await b.generateWebSocketUrl();
      ws = new WebSocket(wsUrl, { headers });
      await new Promise((ok, ng) => { ws!.once('open', ok); ws!.once('error', ng); });
      const send = cdp(ws);
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
      const read = async (expr: string) => ((await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId)) as { result: { value?: string } }).result.value ?? '';
      const open = async (url: string, wait = 2500) => { await send('Page.navigate', { url }, sessionId); await sleep(wait); };
      for (const q of queries) {
        // 공식 사이트 추정이 있으면 그 사이트 안에서 먼저(site:). Google 은 낱말이 많으면 site: 를 무시해 짧은 검색어로 한 번 더(11/18 실측).
        // 결과 칸 글자에 표시 주소(https://도메인 › 경로)가 있어 열기 전에 사용자 게시글을 빼고 공식 도메인을 앞에 둔다
        const site = officialSites.get(q)?.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        const short = q.split(/\s+/).slice(-3).join(' ');
        const G = (x: string) => `https://www.google.com/search?hl=ko&num=10&q=${encodeURIComponent(x)}`;
        const ENGINES: [string, string][] = [
          ...(site ? [[G(`${q} site:${site}`), '#search a:has(h3)'], [G(`${short} site:${site}`), '#search a:has(h3)']] as [string, string][] : []),
          [G(q), '#search a:has(h3)'],
          [`https://www.bing.com/search?setlang=ko&q=${encodeURIComponent(q)}`, 'li.b_algo h2 a'],
        ];
        const hostOf = (href: string, text: string) => {
          const r = resultUrl(href); if (r) return new URL(r).hostname.toLowerCase();
          return (/https?:\/\/([a-z0-9.-]+)/i.exec(text)?.[1] ?? '').toLowerCase();
        };
        const official = (h: string) => !!site && !!h && (h === site || h.endsWith(`.${site}`) || h.replace(/^www\./, '') === site.replace(/^www\./, ''));
        const hits: WebHit[] = [];
        let opened = 0;
        for (const [url, sel] of ENGINES) {
          if (hits.length) break;
          await open(url, 3500);
          const raw = JSON.parse(await read(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel)})].slice(0, 8).map((a) => ({ href: a.href, text: (a.innerText || '').slice(0, 300), title: (a.querySelector('h3')?.innerText || a.innerText || '').split(String.fromCharCode(10))[0].slice(0, 200) })))`) || '[]') as { href: string; text: string; title: string }[];
          const links = raw.map((l) => ({ ...l, host: hostOf(l.href, l.text) }))
            .filter((l) => !(l.host && isCommunity(`https://${l.host}/`)))
            .sort((x, y) => Number(!official(x.host)) - Number(!official(y.host)));
          for (const { href: u, title: linkText } of links) {
            if (hits.length >= this.perQuery || opened >= 6) break;
            opened++;
            try {
              await open(u, 2500);
              // 본문이 그려질 때까지 1초 간격 최대 6초 더 (SPA·블로그는 처음엔 비어 있음)
              let v: { t?: string; b?: string; u?: string } = {};
              for (let k = 0; k < 7; k++) {
                v = JSON.parse(await read(`JSON.stringify({ t: document.title, b: (document.body?.innerText ?? '').slice(0, 4000), u: location.href })`) || '{}') as typeof v;
                if ((v.b ?? '').length > 200) break;
                await sleep(1000);
              }
              const final = new URL(v.u || u);
              if (!/^https?:$/.test(final.protocol) || /(^|\.)(google\.[a-z.]+|bing\.com|msn\.com)$/.test(final.hostname) || isCommunity(final.toString())) continue; // 검색 엔진·사용자 게시글은 버림
              // 접속 차단·점검 중 페이지는 검색 결과 제목으로 대신한다(주소는 맞음). 일치 판정에는 검색 결과 제목도 함께 쓴다
              const blocked = /access denied|forbidden|403|404|not found|attention required|just a moment|점검|maintenance/i.test(v.t ?? '');
              hits.push({ url: final.toString(), title: (blocked || !v.t ? linkText : v.t).slice(0, 200), text: `${linkText}\n${blocked ? '' : v.b ?? ''}` });
            } catch { /* 열지 못한 결과는 건너뜀 */ }
          }
        }
        out.set(q, hits);
      }
      return out;
    } finally {
      ws?.close();
      await b.stopSession().catch(() => {});
    }
  }
}
