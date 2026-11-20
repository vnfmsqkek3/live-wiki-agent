// 관리 > 운영 도구 QA (O1~O4): Agent 실행 기록·규정 변경 영향. QA_SCRIPT=qa-ops.mjs tests/e2e/qa-run.sh
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.QA_BASE ?? 'https://d2d8uulvhqvx4w.cloudfront.net';
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
await login('admin');
await go('/admin', 4000);
const links = await ev("[...document.querySelectorAll('a.btn')].filter((a) => ['Agent 실행 기록', '규정 변경 영향'].includes(a.textContent.trim())).map((a) => a.getAttribute('href'))");
rec('O1', links?.length === 2, `관리 운영 도구 링크 ${JSON.stringify(links)}`);
await go('/admin/runs', 6000);
const runs = await ev("({ n: document.querySelectorAll('.run-list .entry').length, first: document.querySelector('.run-head')?.innerText.replace(/\\s+/g, ' ').slice(0, 120), trace: !!document.querySelector('a[href*=gen-ai-observability]') })");
if (runs.n) { await ev("document.querySelector('.run-head').click()"); await sleep(3000); }
const steps = await ev("document.querySelectorAll('.run-steps li .run-status').length");
rec('O2', runs.n > 0 && steps > 0 && runs.trace, `실행 ${runs.n}건 · 첫 줄 '${runs.first}' · 펼친 단계 ${steps}개 · 추적 링크 ${runs.trace}`);
await shot('O2-runs');
await go('/admin/impact', 5000);
const chips = await ev("[...document.querySelectorAll('.impact-laws .chip')].map((b) => b.textContent)");
let imp = 'no-law';
for (const k of (chips ?? []).keys()) {
  await ev(`document.querySelectorAll('.impact-laws .chip')[${k}].click()`);
  await until(async () => !(await ev("!!document.querySelector('.impact') || !!document.querySelector('[role=alert]')")) ? false : true, 60000, 1000);
  imp = await ev("document.querySelector('.impact') ? 'ok:' + document.querySelector('#chg-h')?.textContent + ' / ' + document.querySelector('#imp-h')?.textContent : 'err:' + document.querySelector('[role=alert]')?.textContent");
  if (imp.startsWith('ok')) break;
}
rec('O3', imp.startsWith('ok'), `규정 ${chips?.length ?? 0}개 · ${imp}`);
await shot('O3-impact');
rec('O4', errors.length === 0 && !net.some((n) => n.status >= 500), `화면 오류 ${errors.length} · 5xx ${net.filter((n) => n.status >= 500).map((n) => n.url.split('/v1/')[1]).join(',')}`);
process.exit(0);
