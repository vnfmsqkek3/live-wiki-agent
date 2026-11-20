// UI 반응형 QA (R1~R2): 390px(모바일)·1440px(데스크톱)에서 주요 화면의 가로 넘침과 스크린샷.
//   QA_BASE=https://<prod CloudFront> QA_SCRIPT=qa-responsive.mjs tests/e2e/qa-run.sh
// 읽기만 한다(업로드·결재 없음). 상세 화면은 user 보관함 첫 카드, 결재 대상 상세는 admin 결재함 첫 문서
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.QA_BASE;
if (!BASE) { console.error('QA_BASE 가 필요합니다 (배포 CloudFront URL)'); process.exit(2); }
const OUT = process.env.QA_OUT ?? './qa-out';
const pw = JSON.parse(readFileSync(0, 'utf8'));
mkdirSync(OUT, { recursive: true });

const t = await (await fetch(`http://127.0.0.1:${process.env.QA_CDP ?? 9333}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const wait = new Map();
const errors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && wait.has(m.id)) { wait.get(m.id)(m.result ?? { error: m.error }); wait.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description?.split('\n')[0]);
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.value;
const until = async (fn, ms, step = 1000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(step); } };
const setInput = (sel, v) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set; set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await send('Page.enable'); await send('Runtime.enable');

async function login(who) {
  await send('Page.navigate', { url: BASE + '/login' }); await sleep(2000);
  await ev('sessionStorage.clear()'); await send('Page.navigate', { url: BASE + '/login' }); await sleep(3000);
  await setInput('#u', who); await setInput('#p', pw[who]);
  await ev("document.querySelector('form button[type=submit]').click()");
  await until(async () => (await ev('location.pathname')) !== '/login', 15000);
  await sleep(2000);
}
// 가로 넘침: 문서 폭이 화면보다 넓거나, 화면 오른쪽 밖으로 나간 요소 (가로 스크롤 영역 안의 요소는 제외)
const measure = (p) => ev(`(() => { const W = document.documentElement.clientWidth; const inScroll = (e) => { for (let p = e.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p).overflowX; if (s === 'auto' || s === 'scroll' || s === 'hidden') return true; } return false; };
  const over = [...document.querySelectorAll('body *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.right > W + 1 && !inScroll(e); }).slice(0, 5).map((e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).join('.') : '') + ' →' + Math.round(e.getBoundingClientRect().right));
  return { path: ${JSON.stringify(p)}, W, scrollW: document.documentElement.scrollWidth, over, h1: document.querySelector('h1')?.textContent?.slice(0, 30) ?? null }; })()`);

const results = [];
for (const [rid, w] of [['R1', 390], ['R2', 1440]]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 600 });
  const rows = [];
  for (const who of ['user', 'admin']) {
    await login(who);
    const pages = who === 'user' ? ['/', '/search', '/search?q=' + encodeURIComponent('담보'), '/library', '/upload', '/guide'] : ['/admin', '/admin/impact', '/admin/runs', '/admin/evals'];
    // 상세: user는 보관함 첫 카드, admin은 결재함 첫 문서 확인 링크
    const firstDetail = who === 'user'
      ? async () => { await send('Page.navigate', { url: BASE + '/library' }); await sleep(5000); return ev("document.querySelector('li.entry a[href*=\"id=\"]')?.getAttribute('href')"); }
      : async () => { await send('Page.navigate', { url: BASE + '/admin' }); await sleep(5000); return ev("document.querySelector('li.entry a[href*=\"from=admin\"]')?.getAttribute('href')"); };
    const d = await firstDetail();
    if (d) pages.push(d);
    for (const p of pages) {
      await send('Page.navigate', { url: BASE + p }); await sleep(5000);
      const m = await measure(p);
      const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      m.shot = `${OUT}/${rid}-${w}-${who}${p.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}.png`;
      writeFileSync(m.shot, Buffer.from(s.data, 'base64'));
      rows.push({ who, ...m });
      console.log(`${m.scrollW > m.W || m.over.length ? 'FAIL' : 'PASS'} ${rid} ${w} ${who} ${p} scrollW ${m.scrollW}/${m.W} ${m.over.join(', ')}`);
    }
  }
  const bad = rows.filter((r) => r.scrollW > r.W || r.over.length);
  results.push({ id: rid, ok: bad.length === 0, detail: `${w}px 화면 ${rows.length}개 중 가로 넘침 ${bad.length}개${bad.length ? ': ' + bad.map((r) => r.path).join(', ') : ''}`, rows });
}
writeFileSync(`${OUT}/qa-responsive-result.json`, JSON.stringify({ base: BASE, at: new Date().toISOString(), results, page_errors: [...new Set(errors)].slice(0, 20) }, null, 2));
console.log(`\n결과: ${OUT}/qa-responsive-result.json`);
ws.close();
process.exit(0);
