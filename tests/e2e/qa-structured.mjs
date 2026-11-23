// 쪽 본문 정리본/원문 전환 QA (R1~R3). QA_DOCS=doc_a,doc_b QA_SCRIPT=qa-structured.mjs tests/e2e/qa-run.sh
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
let found = '';
for (const doc of (process.env.QA_DOCS ?? '').split(',').filter(Boolean)) {
  await go(`/library?id=${encodeURIComponent(doc)}`, 5000);
  if (await ev("!!document.querySelector('.view-toggle')")) { found = doc; break; }
}
if (!found) rec('R1', false, '정리본 전환 버튼이 있는 문서를 찾지 못함');
else {
  const s = await ev("({ pressed: document.querySelector('.view-toggle [aria-pressed=true]')?.textContent, note: !!document.querySelector('.sheet .note'), h: document.querySelectorAll('.sheet .doc-text h2,.sheet .doc-text h3,.sheet .doc-text h4,.sheet table').length })");
  rec('R1', s.pressed === '정리본' && s.note, `${found} 기본 정리본 · 안내문 ${s.note} · 제목/표 ${s.h}개`);
  await shot('R1-structured');
  await ev("[...document.querySelectorAll('.view-toggle button')].find((b) => b.textContent.startsWith('필터링된 원문')).click()");
  await sleep(500);
  const o = await ev("({ pressed: document.querySelector('.view-toggle [aria-pressed=true]')?.textContent, note: !!document.querySelector('.sheet > .note') })");
  rec('R2', o.pressed?.startsWith('필터링된 원문') && !o.note, `필터링된 원문 전환 · ${o.pressed}`);
  await shot('R2-raw');
}
rec('R3', errors.length === 0, `화면 오류 ${errors.length}건 · API 5xx ${net.filter((n) => n.status >= 500).length}건`);
writeFileSync(`${OUT}/qa-structured.json`, JSON.stringify(results, null, 2));
process.exit(0);
