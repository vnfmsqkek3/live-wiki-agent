// 데모 01~06(docs/02 5.1) + 정량 화면 확인(docs/02 4장) QA. 헤드리스 Chrome(CDP)으로 배포 사이트를 실제 조작한다.
//   set -a; . ./.env.local; set +a; QA_BASE=https://<cloudfront> QA_SCRIPT=qa-demo.mjs tests/e2e/qa-run.sh
// env: QA_BASE(필수), QA_OUT, QA_CDP, QA_PART=all|demo (demo = 데모 문서 6건만), QA_APPROVE=1 (정상 문서 실제 승인·게시, 기본 끔)
// prod=데모 환경(11/20): 기본은 아무것도 게시하지 않는다. '승인 가능'(결재함 승인 버튼)까지만 보고, 끝에 이 실행이 게시 요청한 QA 문서를 admin이 모두 반려(BLOCKED, 검색 제외)
// 입력: stdin JSON {"user":"…","admin":"…"} (비밀번호, 출력 금지). 샘플 목록은 tests/evaluations/cases/sets.json (단일 원본)
// 점검표 ID는 tests/e2e/README.md 'qa-demo 점검표'. 올린 [SYNTHETIC] QA 문서는 정리하지 않는다 (hanaeum-qa.md 보고 절차대로 정리)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.env.QA_BASE;
if (!BASE) { console.error('QA_BASE 가 필요합니다 (배포 CloudFront URL)'); process.exit(2); }
const OUT = process.env.QA_OUT ?? './qa-out';
const APPROVE = process.env.QA_APPROVE === '1';
const sets = JSON.parse(readFileSync('tests/evaluations/cases/sets.json', 'utf8'));
const DEMO = { normal: ['F-001', 'K-001'], forged: ['F-003'], attack: ['A-001'], conflict: ['K-002'] };
const S = process.env.QA_PART === 'demo' ? DEMO
  : { normal: sets.normal_register_5, forged: sets.forged_block_5, attack: sets.attack_block_5, conflict: ['K-002'] };
const fileOf = (id) => ['documents/pdf/' + id + '.pdf', 'golden/pdf/' + id + '.pdf', 'documents/' + id + '.png'].map((p) => resolve('tests/fixtures', p)).find(existsSync);
const pw = JSON.parse(readFileSync(0, 'utf8'));
// 데모 계정(사용자 결정 11/20): user = 작성자(업로드·검색·비인가 시도), admin = 승인·반려·관리 화면. approver 없음
mkdirSync(OUT, { recursive: true });

// ---- CDP (qa-flow.mjs 와 같은 방식) ----
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
  if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true, promptText: 'QA 자동 점검' });
  if (m.method === 'Network.responseReceived' && m.params.response.url.includes('/v1/')) net.push({ status: m.params.response.status, url: m.params.response.url, requestId: m.params.requestId });
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description?.split('\n')[0]);
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.value;
const go = async (p, ms = 3500) => { await send('Page.navigate', { url: BASE + p }); await sleep(ms); };
const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); const f = `${OUT}/${name}.png`; writeFileSync(f, Buffer.from(s.data, 'base64')); return f; };
const text = () => ev('document.body.innerText');
const until = async (fn, ms, step = 3000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(step); } };
const setInput = (sel, v) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set; set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const click = (label) => ev(`(() => { const b = [...document.querySelectorAll('button,a')].find((x) => x.textContent.trim() === ${JSON.stringify(label)} && !x.disabled); if (!b) return false; b.click(); return true; })()`);
const api = (path, method = 'GET', body) => ev(`(async () => { const s = JSON.parse(sessionStorage.getItem('hanaeum.session') || 'null'); const r = await fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json', ...(s ? { authorization: 'Bearer ' + s.token } : {}) }, ${body ? `body: ${JSON.stringify(JSON.stringify(body))}` : ''} }); return { status: r.status, body: await r.json().catch(() => null) }; })()`);
const resBody = async (suffix) => { const n = [...net].reverse().find((x) => x.url.endsWith(suffix)); const b = n ? await send('Network.getResponseBody', { requestId: n.requestId }) : null; return b?.body ? JSON.parse(b.body) : null; };

async function findAcrossPages(expression) {
  for (;;) {
    const found = await ev(expression);
    if (found) return found;
    const before = await ev('location.href');
    const next = await ev("(() => { const b = document.querySelector('button[data-page-next]:not(:disabled)'); if (!b) return false; b.click(); return true; })()");
    if (!next) return false;
    if (!(await until(async () => (await ev('location.href')) !== before, 5000, 100))) return false;
    await sleep(250);
  }
}

await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });

const results = [];
const check = (id, ok, detail, evidence) => { results.push({ id, ok, detail, ...(evidence ? { evidence } : {}) }); console.log(`${ok === true ? 'PASS' : ok === 'partial' ? 'PART' : 'FAIL'} ${id} ${detail}`); };
let who = '';
async function login(name) {
  if (who === name) return;
  await go('/', 1500); await ev('sessionStorage.clear()'); await go('/', 3000);
  await setInput('#u', name); await setInput('#p', pw[name]);
  await ev("document.querySelector('form button[type=submit]').click()");
  await until(async () => (await ev('location.pathname')) !== '/login', 15000, 1000);
  await sleep(2000);
  who = name;
}

// ---- 문서 단위 동작 ----
const stamp = new Date().toISOString().slice(5, 16).replace('T', ' ');
const docs = {}; // sample id → { title, docId, lifecycle, reasons, submit, approval_id, admin }

async function upload(sid) {
  const title = `[SYNTHETIC] QA ${sid} ${stamp}`;
  await go('/upload');
  const doc = await send('DOM.getDocument', {});
  const input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#f' });
  await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [fileOf(sid)] });
  await setInput('#t', title);
  await sleep(500);
  await click('분석 시작');
  await until(async () => net.some((n) => n.url.endsWith('/v1/documents/upload-url')) && /분석 중|분석이|차단/.test(await text()), 60_000, 1000);
  const docId = (await resBody('/v1/documents/upload-url'))?.doc_id;
  net.length = 0;
  docs[sid] = { title, docId };
  console.log(`  올림 ${sid} → ${docId ?? '실패'}`);
}

// 분석은 서버에서 계속된다 → 모두 올린 뒤 한꺼번에 기다린다 (첫 OCR 콜드 스타트 ~11분, dev 실측 11/17)
async function waitAnalysis(ids) {
  await until(async () => {
    for (const sid of ids) {
      const d = docs[sid];
      if (!d.docId || d.done) continue;
      const p = (await api(`/v1/documents/${encodeURIComponent(d.docId)}/progress`)).body;
      if (p && (p.finished || p.halted || p.lifecycle !== 'QUARANTINED')) Object.assign(d, { done: true, lifecycle: p.lifecycle, halted: p.halted, reasons: p.blocked_reasons ?? [] });
    }
    return ids.every((sid) => !docs[sid].docId || docs[sid].done);
  }, 20 * 60_000, 15_000);
}

// 검토 화면에서 게시 요청. 막히면 막힌 이유를 화면에서 읽는다
async function submit(sid) {
  const d = docs[sid];
  if (!d.docId) return;
  await go(`/review?id=${encodeURIComponent(d.docId)}`, 6000);
  const st = await ev("(() => { const b = document.querySelector('.submit-bar button'); return { label: b?.textContent.trim(), disabled: !!b?.disabled, blockers: document.querySelector('.blockers')?.innerText ?? '', steps: document.querySelector('.steps-line')?.innerText.replace(/\\s+/g, ' ') ?? '' }; })()");
  d.review = await text();
  d.reviewShot = await shot(`${sid}-review`);
  if (st.disabled) { d.submit = { ok: false, why: `버튼 비활성 '${st.label}' ${st.steps} ${st.blockers.slice(0, 150)}` }; return; }
  await ev("document.querySelector('.submit-bar button').click()");
  await sleep(3000);
  const msg = await ev("document.querySelector('.submit-msg')?.textContent ?? ''");
  d.approval_id = (await resBody('/submit'))?.approval_id;
  d.submit = { ok: /게시를 요청했습니다/.test(msg), why: msg.slice(0, 150) };
}

// 결재함 카드 상태: approvable(승인 가능) / reject-only / absent. approve=true 면 열람 후 승인
async function adminCard(sid, approve) {
  const d = docs[sid];
  await login('admin');
  await go('/admin', 5000);
  const sel = `[...document.querySelectorAll('li.entry')].find((x) => x.innerText.includes(${JSON.stringify(d.title)}))`;
  const state = await findAcrossPages(`(() => { const li = ${sel}; if (!li) return false; return [...li.querySelectorAll('button')].some((x) => x.textContent.trim() === '승인') ? 'approvable' : 'reject-only'; })()`) || 'absent';
  d.admin = state;
  if (!approve || state !== 'approvable') return state;
  // L1: 문서를 열어 본 뒤에만 승인 (사용자 결정 11/18)
  await findAcrossPages(`(() => { const li = ${sel}; const v = li && [...li.querySelectorAll('a')].find((x) => /문서 확인|다시 보기/.test(x.textContent)); v?.click(); return !!v; })()`);
  await sleep(4000);
  await go('/admin', 5000);
  await findAcrossPages(`(() => { const li = ${sel}; if (!li) return false; [...li.querySelectorAll('button')].find((x) => x.textContent.trim() === '원문과 근거 조문을 확인함')?.click(); const b = [...li.querySelectorAll('button')].find((x) => x.textContent.trim() === '승인'); setTimeout(() => b?.click(), 300); return true; })()`);
  await sleep(4000);
  d.approved = /승인했습니다/.test(await ev("document.querySelector('p[aria-live]')?.textContent ?? ''"));
  return state;
}

const lifecycle = async (sid) => (await api(`/v1/documents/${encodeURIComponent(docs[sid].docId)}`)).body?.lifecycle;
async function userSees(sid) {
  await login('user');
  await go(`/search?q=${encodeURIComponent(docs[sid].title.replace('[SYNTHETIC] ', ''))}`, 5000);
  return !!(await findAcrossPages(`[...document.querySelectorAll('li.entry')].some((x) => x.innerText.includes(${JSON.stringify(docs[sid].title)}))`));
}
const blockedAt = (d) => d.lifecycle === 'BLOCKED' ? `분석 차단(${d.reasons.join(', ').slice(0, 80) || '사유 없음'})` : !d.submit?.ok ? `게시 요청 거부(${d.submit?.why ?? '?'})` : d.admin === 'reject-only' ? '결재함 반려만' : null;

// ================= 실행 =================
await login('user');
const first = [...S.normal, ...S.forged, ...S.attack, ...S.conflict];
for (const sid of first) await upload(sid);
await waitAnalysis(first);
for (const sid of first) await submit(sid);

// Q1 정상 등록: 게시 요청 성공 + 결재함 승인 가능 (+ 승인 → PUBLISHED)
for (const sid of S.normal) await adminCard(sid, APPROVE);
if (APPROVE) await until(async () => { await login('user'); for (const sid of S.normal) if (docs[sid].approved) docs[sid].final = await lifecycle(sid); return S.normal.every((s) => !docs[s].approved || docs[s].final === 'PUBLISHED'); }, 10 * 60_000, 15_000);
for (const sid of S.normal) {
  const d = docs[sid];
  const ok = d.submit?.ok && d.admin === 'approvable' && (!APPROVE || d.final === 'PUBLISHED');
  check(`Q1 ${sid}`, ok ? true : d.submit?.ok ? 'partial' : false, `분석 ${d.lifecycle} · 게시 요청 ${d.submit?.ok ? '성공' : d.submit?.why} · 결재함 ${d.admin}${APPROVE ? ` · 승인 ${d.approved ? '성공' : '실패'} → ${d.final ?? '-'}` : ''}`, d.reviewShot);
}

// Q2 위조 차단 / Q3 Injection 차단: 게시까지 못 가고 user 검색에 없음. 사람 반려가 필요하면 partial
for (const [q, list] of [['Q2', S.forged], ['Q3', S.attack]]) for (const sid of list) {
  const d = docs[sid];
  if (d.submit?.ok) await adminCard(sid, false);
  const where = blockedAt(d);
  const seen = d.docId ? await userSees(sid) : false;
  check(`${q} ${sid}`, seen ? false : where ? true : 'partial', `${where ?? `결재함에 승인 가능으로 올라옴(사람 반려 필요)`} · user 검색 ${seen ? '보임' : '안 보임'}`, d.reviewShot);
}

// Q4 비인가 게시: user 세션으로 결재 결정 5회 → 모두 403, 결재는 대기 유지, /admin 화면 차단
const target = [...S.normal, ...S.conflict].map((s) => docs[s]).find((d) => d.approval_id && !d.approved) ?? docs[S.normal.find((s) => docs[s].approval_id)];
await login('user');
const tries = [];
if (target?.approval_id) for (const decision of ['APPROVE', 'APPROVE', 'REJECT', 'REVALIDATE', 'APPROVE']) tries.push((await api(`/v1/approvals/${target.approval_id}/decision`, 'POST', { decision, reason: 'QA 비인가 시도' })).status);
await go('/admin');
const adminBlocked = /볼 수 없는 화면/.test(await text());
const q4shot = await shot('Q4-user-admin');
check('Q4', tries.length === 5 && tries.every((s) => s === 403) && adminBlocked, `결정 요청 ${tries.join(',') || '대상 없음(게시 요청된 미승인 문서 없음)'} · user /admin 차단 ${adminBlocked}${APPROVE ? ' (승인한 문서는 대상 제외)' : ''}`, q4shot);

// ---- 데모 01~06 ----
// M01 메인 검색
await login('user');
await go('/', 5000);
const home = await ev("({ search: !!document.querySelector('input[aria-label=검색어]'), cards: document.querySelectorAll('li.entry').length, chips: document.querySelectorAll('.chip').length })");
check('M01', home.search && home.cards > 0 ? (home.chips > 0 ? true : 'partial') : false, `검색창 ${home.search} · 추천 카드 ${home.cards} · 태그 ${home.chips}`, await shot('M01-home'));

// M02 Trust Gate: F-001 승인, F-003 차단, A-001 검사 결과, 차단 문서 검색 제외
const f3 = docs['F-003'], a1 = docs['A-001'];
const m02 = [
  ['F-001 승인', docs['F-001'].admin === 'approvable'],
  ['F-003 차단', !!blockedAt(f3)],
  ['A-001 보안 검사 결과 표시', /보안 검사/.test(a1.review ?? '') || a1.lifecycle === 'BLOCKED'],
  ['차단 문서 검색 제외', !(await userSees('F-003')) && !(await userSees('A-001'))],
];
check('M02', m02.every(([, v]) => v) ? true : 'partial', m02.map(([k, v]) => `${k} ${v ? 'O' : 'X'}`).join(' · '));

// M03 노하우 검증: K-001 근거 확인, K-002 충돌 표시 + 게시 보류
const k1 = docs['K-001'].review ?? '', k2 = docs['K-002'];
const m03 = [
  ['K-001 관련 규정 표시', /근거 규정과 맞습니다|근거 확인됨|실무 보완/.test(k1)],
  ['K-002 충돌 표시', /규정과 충돌하는 내용이 있습니다|규정과 어긋남/.test(k2.review ?? '')],
  ['K-002 게시 보류', !k2.submit?.ok || k2.admin === 'reject-only'],
];
check('M03', m03.every(([, v]) => v) ? true : 'partial', m03.map(([k, v]) => `${k} ${v ? 'O' : 'X'}`).join(' · '), k2.reviewShot);

// M04 Change Impact: F-001 게시 뒤 F-002 등록 → 새 버전 표시, 관리 > 규정 변경 영향에 바뀐 조문·영향 노하우
if (docs['F-001'].final === 'PUBLISHED') {
  await login('user');
  await upload('F-002');
  await waitAnalysis(['F-002']);
  await submit('F-002');
}
const ver = /새 버전/.test(docs['F-002']?.review ?? '');
await login('admin');
await go('/admin/impact', 5000);
const chips = (await ev("[...document.querySelectorAll('.impact-laws .chip')].map((b) => b.textContent)")) ?? [];
let imp = '규정 없음';
const k = Math.max(0, chips.findIndex((c) => /여신/.test(c)));
if (chips.length) {
  await ev(`document.querySelectorAll('.impact-laws .chip')[${k}].click()`);
  await until(async () => ev("!!document.querySelector('.impact') || !!document.querySelector('[role=alert]')"), 60_000, 1000);
  imp = await ev("document.querySelector('.impact') ? document.querySelector('#chg-h')?.textContent + ' / ' + document.querySelector('#imp-h')?.textContent : 'err:' + document.querySelector('[role=alert]')?.textContent");
}
const impOk = /바뀐 조문 [1-9]/.test(imp) && /영향받는 노하우 [1-9]/.test(imp);
check('M04', ver && impOk ? true : ver || impOk ? 'partial' : false, `F-002 ${docs['F-002'] ? (ver ? '새 버전 연결 표시' : '새 버전 표시 없음') : 'F-001 미게시로 생략'} · 영향 '${chips[k] ?? '-'}' ${imp}`, await shot('M04-impact'));

// M05 Trust-aware Search + 가이드: 조문·시행일·검증 상태
await login('user');
const q = '담보평가 시 확인 절차는?';
await go(`/search?q=${encodeURIComponent(q)}`, 6000);
const st = await text();
const m05s = { results: await ev("document.querySelectorAll('li.entry').length"), clause: /제\d+조/.test(st), date: /시행/.test(st), seal: await ev("document.querySelectorAll('.seal').length") };
const m05shot = await shot('M05-search');
await go(`/guide?q=${encodeURIComponent(q)}`, 3000);
await until(async () => /참고용 가이드|근거를 찾지 못했습니다/.test(await text()) || !!(await ev("document.querySelector('[role=alert]')")), 120_000, 3000);
const gt = await text();
const guide = /참고용 가이드/.test(gt) ? '가이드 생성' : /근거를 찾지 못했습니다/.test(gt) ? '근거 없음' : '오류/시간 초과';
await shot('M05-guide');
check('M05', m05s.results > 0 && m05s.clause && m05s.date && m05s.seal > 0 && guide === '가이드 생성' ? true : m05s.results > 0 ? 'partial' : false, `검색 ${m05s.results}건 · 조문 ${m05s.clause} · 시행일 ${m05s.date} · 검증 인장 ${m05s.seal} · 가이드 ${guide}`, m05shot);

// M06 Agent Governance: 비인가 거부(Q4) + 실행 기록·Trace 링크 + 평가 결과 화면
await login('admin');
await go('/admin/runs', 6000);
const runs = await ev("({ n: document.querySelectorAll('.run-list .entry').length, trace: !!document.querySelector('a[href*=gen-ai-observability]') })");
const evalScreen = await ev("[...document.querySelectorAll('a')].some((a) => /평가/.test(a.textContent))");
const q4 = results.find((r) => r.id === 'Q4')?.ok === true;
check('M06', q4 && runs.n > 0 && runs.trace && evalScreen ? true : q4 ? 'partial' : false, `비인가 거부 ${q4} · 실행 기록 ${runs.n}건 · Trace 링크 ${runs.trace} · 평가 결과 화면 ${evalScreen ? '있음' : '없음(docs/02 허용 경로: 자체 평가 결과표)'}`, await shot('M06-runs'));

// 정리: 이 실행이 게시 요청했고 승인하지 않은 QA 문서는 admin이 반려 → 결재함·검색에 남지 않음
await login('admin');
const cleanup = {};
for (const [sid, d] of Object.entries(docs)) if (d.approval_id && !d.approved) cleanup[sid] = (await api(`/v1/approvals/${d.approval_id}/decision`, 'POST', { decision: 'REJECT', reason: 'QA 자동 점검 정리' })).status;
console.log(`정리(반려): ${JSON.stringify(cleanup)}`);

writeFileSync(`${OUT}/qa-demo-result.json`, JSON.stringify({
  base: BASE, at: new Date().toISOString(), part: process.env.QA_PART ?? 'all', approve: APPROVE, results, cleanup,
  docs: Object.fromEntries(Object.entries(docs).map(([k, d]) => [k, { title: d.title, doc_id: d.docId, lifecycle: d.lifecycle, final: d.final, submit: d.submit, admin: d.admin }])),
  page_errors: [...new Set(errors)].slice(0, 20), api_errors: net.filter((n) => n.status >= 400 && !n.url.includes('/decision')).map((n) => `${n.status} ${new URL(n.url).pathname}`),
}, null, 2));
console.log(`\n결과: ${OUT}/qa-demo-result.json · 정리 대상 doc_id: ${Object.values(docs).map((d) => d.docId).filter(Boolean).join(' ')}`);
ws.close();
process.exit(0);
