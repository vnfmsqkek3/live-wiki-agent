// 결재함 → 문서 상세 QA (A1~A3, let522mj 요청 1056). 입력·실행은 qa-flow.mjs와 같다: QA_SCRIPT=qa-admin.mjs tests/e2e/qa-run.sh
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


// 각 독립 목록의 다음 쪽을 끝까지 확인한다. API 호출 대신 실제 화면 버튼을 사용한다.
async function findAcrossPages(expression) {
  for (;;) {
    const found = await ev(expression);
    if (found) return found;
    const before = await ev('location.href');
    const next = await ev("(() => { const b = document.querySelector('button[data-page-next]:not(:disabled)'); if (!b) return false; b.click(); return true; })()");
    if (!next) return false;
    const changed = await until(async () => (await ev('location.href')) !== before, 5000, 100);
    if (!changed) throw new Error('페이지네이션 다음 쪽 이동 실패');
    await sleep(250);
  }
}

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
await login('admin');
await go('/admin', 5000);
const collected = new Map();
for (;;) {
  const visible = await ev("[...document.querySelectorAll('.doc-title a')].map((a) => [a.textContent.trim(), a.getAttribute('href')])");
  for (const link of visible) collected.set(link[1], link);
  const before = await ev('location.href');
  const next = await ev("(() => { const b = document.querySelector('button[data-page-next]:not(:disabled)'); if (!b) return false; b.click(); return true; })()");
  if (!next) break;
  if (!await until(async () => (await ev('location.href')) !== before, 5000, 100)) throw new Error('페이지네이션 다음 쪽 이동 실패');
  await sleep(250);
}
const links = [...collected.values()];
// 결재 대상이 하나도 없으면(예: 공격·위조 문서를 올리지 않은 prod) 실패가 아니라 해당 없음
check('A1', links.length === 0 ? 'partial' : links.every(([, h]) => h.includes('from=admin')), links.length ? `결재함 제목 링크 ${links.length}개` : '결재 대상 없음 (해당 없음)', await shot('A1-admin'));
// 점검 대상: QA_ADMIN_DOCS(쉼표, doc_id)가 없으면 결재함 목록에 지금 있는 문서 앞에서 3건 (데이터 초기화 뒤에도 동작)
const targets = process.env.QA_ADMIN_DOCS ? process.env.QA_ADMIN_DOCS.split(',').map((id) => [id.slice(-6), id])
  : links.slice(0, 3).map(([t, h]) => [t.slice(0, 20), new URL(h, BASE).searchParams.get('id')]);
for (const [name, id] of targets) {
  await go('/admin', 4000);
  const ok = await findAcrossPages(`(() => { const a = [...document.querySelectorAll('.doc-title a')].find((x) => x.getAttribute('href').includes(${JSON.stringify(id)})); if (!a) return false; a.click(); return true; })()`);
  if (!ok) await go(`/library?id=${id}&from=admin`);
  await sleep(5000);
  await ev("[...document.querySelectorAll('button.detail-card')].find((b) => b.textContent.trim() === '확인이 필요한 이유')?.click()");
  await sleep(200);
  const why = await ev("document.getElementById('why-h')?.closest('section')?.innerText ?? ''");
  const first = await ev("(() => { const b = document.querySelector('#why-h')?.closest('section')?.querySelector('button.linklike'); if (!b) return ''; b.click(); return b.textContent; })()");
  await sleep(800);
  const on = await ev("document.querySelector('.fix.on')?.innerText ?? ''");
  await ev("document.querySelector('dialog[open] .popup-header button')?.click()");
  await sleep(100);
  const decide = await ev("document.getElementById('decide-h')?.closest('section')?.innerText ?? ''");
  const back = await ev("[...document.querySelectorAll('a')].some((a) => a.textContent.includes('결재함으로'))");
  check(`A2 ${name}`, !!why && back, `${ok ? '목록 클릭' : '직접 이동'} · ${why.replace(/\s+/g, ' ').slice(0, 220)}`, await shot(`A2-${name}`));
  check(`A3 ${name}`, !first || !!on, `이유 클릭 '${first}' → 활성 밑줄 ${on ? 'O' : 'X'} · 결재 구역: ${decide.replace(/\s+/g, ' ').slice(0, 60) || '없음'}`);
  await go('/admin', 4000);
}
console.log('errors', JSON.stringify(errors.slice(0, 5)), 'api>=400', JSON.stringify(net.filter((n) => n.status >= 400).map((n) => `${n.status} ${n.url.replace(BASE, '')}`).slice(0, 8)));
writeFileSync(`${OUT}/qa-admin.json`, JSON.stringify(results, null, 2));
process.exit(0);
