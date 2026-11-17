// 검색 질의 재구성 화면 QA (Q1~Q4): 이 검색어로 찾았습니다·추천 질의 칩·원래 질의로 찾기. QA_SCRIPT=qa-search-rewrite.mjs tests/e2e/qa-run.sh
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.QA_BASE ?? 'https://d3k1kbwh1nvr8d.cloudfront.net';
const OUT = process.env.QA_OUT ?? './qa-out';

const pw = JSON.parse(readFileSync(0, 'utf8'));
mkdirSync(OUT, { recursive: true });

const t = await (await fetch(`http://127.0.0.1:${process.env.QA_CDP ?? 9333}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const wait = new Map();
const net = [];
const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && wait.has(m.id)) { wait.get(m.id)(m.result ?? { error: m.error }); wait.delete(m.id); }
  if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true, promptText: 'QA 자동 점검 승인' });
  if (m.method === 'Network.responseReceived' && m.params.response.url.includes('/v1/')) net.push({ status: m.params.response.status, url: m.params.response.url, requestId: m.params.requestId });
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description?.split('\n')[0]);
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.value;
const go = async (p, ms = 3500) => { await send('Page.navigate', { url: BASE + p }); await sleep(ms); };
const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); const f = `${OUT}/${name}.png`; writeFileSync(f, Buffer.from(s.data, 'base64')); return f; };
const until = async (fn, ms, step = 3000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(step); } };
const setInput = (sel, v) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set; set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);


await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 520, height: 1200, deviceScaleFactor: 1, mobile: false });

const results = [];
const check = (id, ok, detail, evidence) => { results.push({ id, ok, detail, ...(evidence ? { evidence } : {}) }); console.log(`${ok === true ? 'PASS' : ok === 'partial' ? 'PART' : 'FAIL'} ${id} ${detail}`); };

async function login(who) {
  await go('/', 1500); await ev('sessionStorage.clear()'); await go('/', 3000);
  const first = await ev('location.pathname');
  await setInput('#u', who); await setInput('#p', pw[who]);
  await ev("document.querySelector('form button[type=submit]').click()");
  await until(async () => (await ev('location.pathname')) !== '/login', 15000, 1000);
  await sleep(2000);
  return { first, tabs: await ev("[...document.querySelectorAll('nav.tabs a')].map((a) => a.textContent.trim())") };
}
const rec = (id, ok, note) => check(id, ok, note);
const Q = '개인정보 관련된 문서들을 찾아줘';
const view = () => ev("({ url: location.search, line: document.querySelector('.rewritten p')?.textContent, chips: [...document.querySelectorAll('.rewritten .chip')].map((b) => b.textContent), raw: !![...document.querySelectorAll('.rewritten button')].find((b) => b.textContent === '원래 질의로 찾기'), results: document.querySelectorAll('.result-list .entry').length, busy: !!document.querySelector('main')?.textContent.includes('찾는 중입니다') })");
const settle = () => until(async () => !(await view()).busy, 30000, 1000);
await login('user');
await go(`/search?q=${encodeURIComponent(Q)}`, 2000); await settle();
const a = await view();
rec('Q1', /이 검색어로 찾았습니다: .+/.test(a.line ?? '') && a.results > 0, `'${a.line}' · 결과 ${a.results}건`);
rec('Q2', a.chips.length > 0 && a.raw, `추천 칩 ${JSON.stringify(a.chips)} · 원래 질의 버튼 ${a.raw}`);
await shot('Q1-rewritten');
await ev("[...document.querySelectorAll('.rewritten button')].find((b) => b.textContent === '원래 질의로 찾기').click()");
await sleep(1500); await settle();
const b = await view();
rec('Q3', b.url.includes('raw=1') && !b.line, `원래 질의 → ${b.url.includes('raw=1') ? 'raw=1' : 'raw 없음'} · 안내 줄 ${b.line ? '있음' : '없음'} · 결과 ${b.results}건`);
if (a.chips.length) {
  await go(`/search?q=${encodeURIComponent(Q)}`, 2000); await settle();
  await ev("document.querySelector('.rewritten .chip').click()");
  await sleep(1500); await settle();
  const c = await view();
  rec('Q4', decodeURIComponent(c.url).includes(`q=${a.chips[0]}`) && !c.url.includes('raw=1'), `칩 '${a.chips[0]}' → ${decodeURIComponent(c.url).slice(0, 60)} · 결과 ${c.results}건`);
} else rec('Q4', null, '칩 없음 (Haiku 재구성 실패 시 규칙만)');
rec('Q5', errors.length === 0 && !net.some((n) => n.status >= 500), `화면 오류 ${errors.length} · 5xx ${net.filter((n) => n.status >= 500).length}`);
process.exit(0);
