// 하나이음 QA 흐름 (에이전트 정의: .claude/agents/hanaeum-qa.md). 헤드리스 Chrome(CDP)로 배포 사이트를 실제로 조작한다.
// user 업로드 → 게시 요청 → admin 승인 → 게시 대기 → user 검색 → 보관함 카드 → 상세 점검. 결과는 OUT/qa-result.json + 스크린샷.
// 입력: stdin JSON {"user":"…","admin":"…"} (비밀번호, 출력 금지), env QA_BASE, QA_OUT, QA_FILES(쉼표), QA_CDP(기본 9333)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const BASE = process.env.QA_BASE ?? 'https://d3k1kbwh1nvr8d.cloudfront.net';
const OUT = process.env.QA_OUT ?? './qa-out';
const FILES = (process.env.QA_FILES ?? 'tests/fixtures/documents/pdf/K-001.pdf').split(',').map((f) => resolve(f.trim()));
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
const text = () => ev('document.body.innerText');
const until = async (fn, ms, step = 3000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(step); } };
const setInput = (sel, v) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set; set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const click = (label, scope = 'document') => ev(`(() => { const b = [...${scope}.querySelectorAll('button,a')].find((x) => x.textContent.replace(/내용 있음|\d+건$/g, '').trim() === ${JSON.stringify(label)} && !x.disabled); if (!b) return false; b.click(); return true; })()`);
const api = (path) => ev(`(async () => { const s = JSON.parse(sessionStorage.getItem('hanaeum.session') || 'null'); const r = await fetch(${JSON.stringify(path)}, { headers: s ? { authorization: 'Bearer ' + s.token } : {} }); return { status: r.status, body: await r.json().catch(() => null) }; })()`);

// Read the rendered modal content, then return to the detail cards.
const closeDetail = async () => { await ev("document.querySelector('dialog[open] .popup-header button')?.click()"); };
const readDetail = async (title) => {
  const opened = await click(title);
  if (!opened) return '';
  await sleep(200);
  const content = await ev("document.querySelector('dialog[open]')?.innerText ?? ''");
  await closeDetail();
  return content;
};


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

for (const file of FILES) {
  const tag = basename(file).replace(/\.[^.]+$/, '');
  const title = `[SYNTHETIC] QA ${tag} ${new Date().toISOString().slice(5, 16).replace('T', ' ')}`;
  console.log(`\n# ${title}`);

  // F1 첫 접속 + user 로그인
  const u = await login('user');
  check('F1', u.first === '/login' && u.tabs.includes('등록') && !u.tabs.includes('결재함'), `첫 화면 ${u.first}, user 탭 ${u.tabs.join('·')}`);

  // F2 업로드
  await go('/upload');
  const doc = await send('DOM.getDocument', {});
  const input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#f' });
  await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] });
  await setInput('#t', title);
  await sleep(500);
  net.length = 0;
  await click('분석 시작');
  const done = await until(async () => /분석이 끝났습니다|분석이 멈췄습니다|차단되어/.test(await text()), 15 * 60_000, 4000); // 전부 OCR 전환 뒤 첫 OCR은 GPU 콜드 스타트로 ~11분 (dev 실측 11/17)
  const upRes = net.find((n) => n.url.endsWith('/v1/documents/upload-url'));
  const body = upRes ? await send('Network.getResponseBody', { requestId: upRes.requestId }) : null;
  const docId = body?.body ? JSON.parse(body.body).doc_id : undefined;
  const prog = await ev("document.querySelector('.progress')?.innerText ?? ''");
  check('F2', !!done && /분석이 끝났습니다/.test(prog), `doc ${docId ?? '?'} · ${prog.split('\n')[0] ?? '진행 표시 없음'}`, await shot(`${tag}-F2-upload`));

  // F3 확인할 내용
  const issues = await ev("document.querySelector('.issues')?.innerText ?? ''");
  check('F3', issues ? true : 'partial', issues ? `사유 목록 표시 (${issues.split('\n').slice(0, 2).join(' / ').slice(0, 120)})` : '사유 목록 없음(문제가 없으면 정상)');
  if (!docId) { check('F4', false, 'doc_id를 얻지 못해 이후 단계 중단'); continue; }

  // F4 게시 요청
  await go(`/review?id=${encodeURIComponent(docId)}`, 5000);
  const reviewHas = await text();
  await click('검토 마치고 게시 요청'); await sleep(3000);
  const afterSubmit = await text();
  check('F4', /게시를 요청했습니다/.test(afterSubmit), /게시를 요청했습니다/.test(afterSubmit) ? '게시 요청 성공' : `게시 요청 실패: ${(afterSubmit.match(/(지금 상태에서는[^\n]*|unclassified[^\n]*|[^\n]*요청할 수 없습니다[^\n]*)/) ?? ['?'])[0]}`, await shot(`${tag}-F4-review`));
  const reviewInfo = { verdict: /근거 규정과 맞습니다|충돌|개정 전|확인하지 못했습니다/.exec(reviewHas)?.[0] ?? null };

  // G1 user가 /admin
  await go('/admin');
  check('G1', /볼 수 없는 화면/.test(await text()), 'user의 /admin 접근 차단 안내');

  // F5 admin 승인
  const a = await login('admin');
  await go('/admin', 5000);
  const approved = await findAcrossPages(`(() => { const li = [...document.querySelectorAll('li.entry')].find((x) => x.innerText.includes(${JSON.stringify(title)})); if (!li) return false; const b = [...li.querySelectorAll('button')].find((x) => x.textContent.trim() === '승인'); if (!b) return 'nobutton'; b.click(); return 'clicked'; })()`);
  await sleep(4000);
  const adminMsg = await ev("document.querySelector('p[aria-live]')?.textContent ?? ''");
  check('F5', approved === 'clicked' && /승인했습니다/.test(adminMsg), `admin 탭 ${a.tabs.join('·')} · 결재함 ${approved} · ${adminMsg.slice(0, 80)}`, await shot(`${tag}-F5-admin`));

  // F6 게시 완료
  const pub = await until(async () => (await api(`/v1/documents/${docId}`)).body?.lifecycle === 'PUBLISHED', 10 * 60_000, 10_000);
  const d = (await api(`/v1/documents/${docId}`)).body;
  check('F6', !!pub, `lifecycle ${d?.lifecycle} · authority ${d?.authority_status}${d?.workflow_failure ? ` · 실패 ${d.workflow_failure.step}:${d.workflow_failure.error}` : ''}`);

  // F7 검색 (user)
  await login('user');
  const q = tag === 'K-001' ? '감정평가서 발급일' : title.replace('[SYNTHETIC] ', '').slice(0, 20);
  const found = await until(async () => { await go(`/search?q=${encodeURIComponent(q)}`, 5000); return findAcrossPages(`[...document.querySelectorAll('li.entry')].some((x) => x.innerText.includes(${JSON.stringify(title)}))`); }, 3 * 60_000, 15_000);
  check('F7', !!found, `검색 '${q}' → ${found ? '올린 문서 나옴' : '안 나옴'}`, await shot(`${tag}-F7-search`));

  // F8 보관함 카드 → 상세
  await go('/library', 5000);
  // 제목이 아니라 카드 빈 곳(왼쪽 아래)을 실제 마우스로 누른다
  const pos = await findAcrossPages(`(() => { const li = [...document.querySelectorAll('li.entry')].find((x) => x.innerText.includes(${JSON.stringify(title)})); if (!li) return null; li.scrollIntoView(); const r = li.getBoundingClientRect(); return { x: r.left + 24, y: r.bottom - 8 }; })()`);
  if (pos) for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  const clicked = !!pos;
  await sleep(6000);
  const detailUrl = await ev('location.href');
  check('F8', clicked && detailUrl.includes('id='), clicked ? (detailUrl.includes('id=') ? '카드 빈 곳 클릭 → 상세' : '카드 빈 곳 클릭해도 이동 안 함') : '보관함에 카드 없음');
  const dt = await ev("Object.fromEntries([...document.querySelectorAll('dl.meta-grid dt')].map((x) => [x.textContent.trim(), x.nextElementSibling?.textContent.trim()]))");
  const verification = await readDetail('검증 정보');
  const comparison = await readDetail('비교한 대상');
  const body2 = verification + '\n' + comparison;
  const det = (await api(`/v1/library/${docId}`)).body;
  const evShot = await shot(`${tag}-D-detail`);
  check('D1', dt['등록일'] ? (/(작성|개정|문서 일자)/.test(Object.keys(dt).join()) ? true : 'partial') : false, `등록일 ${dt['등록일'] ?? '없음'} · 문서 자체 작성·개정일 ${/(작성|개정|문서 일자)/.test(Object.keys(dt).join()) ? '있음' : '표시 없음'}`, evShot);
  const hasBasis = /비교한 대상/.test(comparison) && comparison.trim().length > '비교한 대상 닫기'.length;
  check('D2', hasBasis ? true : (det?.related?.length ? 'partial' : false), hasBasis ? '검증 근거 구역 있음' : `검증 근거 구역 없음 (연관 ${det?.related?.length ?? 0}건, 리뷰 판정 ${reviewInfo.verdict ?? '-'})`);
  const renderedPages = [];
  const renderedSummaries = [];
  for (let pi = 0; pi < (det?.pages?.length ?? 0); pi++) {
    renderedPages.push(await ev("document.querySelector('.sheet.page')?.innerText.trim() ?? ''"));
    renderedSummaries.push(await readDetail('페이지 요약'));
    if (pi + 1 < det.pages.length) { await click('다음 쪽'); await sleep(200); }
  }
  for (let pi = 1; pi < renderedPages.length; pi++) { await click('이전 쪽'); await sleep(100); }
  check('D3', renderedPages.length > 0 && renderedPages.every(Boolean) && det.pages.every((p) => p.text?.length > 0), `쪽 ${renderedPages.length}개 본문 렌더 확인`);
  check('D4', /승인자|검증한 사람|검증자/.test(body2), /승인자|검증한 사람|검증자/.test(body2) ? '검증한 사람 표시' : '검증한 사람 표시 없음');
  check('D5', /승인 시각|승인일|검증 시각|검증일/.test(body2), /승인 시각|승인일|검증 시각|검증일/.test(body2) ? '검증 시점 표시' : '검증 시점 표시 없음');
  const sums = det?.pages?.map((p, i) => !!p.summary && renderedSummaries[i].includes(p.summary)) ?? [];
  check('D6', sums.length > 0 && sums.every(Boolean) ? true : sums.some(Boolean) ? 'partial' : false, `쪽 요약 ${sums.filter(Boolean).length}/${sums.length}`);
  const citesLaw = /「[^」]+법」/.test(det?.pages?.map((p) => p.text).join('\n') ?? '');
  if (citesLaw) await click('외부 법령 참고');
  const hasExt = citesLaw ? !!(await until(async () => /외부 법령 최신본 참고/.test(await text()) && !/확인하는 중입니다…/.test(await text()), 60_000, 3000)) : false;
  if (hasExt) await shot(`${tag}-D7-external`);
  check('D7', !citesLaw ? 'partial' : hasExt, !citesLaw ? '본문에 「…법」 인용 없음 (해당 없음)' : hasExt ? '외부 법령 참고 표시' : '본문이 「…법」을 인용하지만 외부 법령 참고 없음');
  await closeDetail();
  const notes = await readDetail('확인된 근거·실무 보완');
  check('D9', tag === 'K-001' ? /근거 확인됨|실무 보완/.test(notes) : 'partial', tag === 'K-001' ? (notes ? `참고 구역: ${notes.split('\n').filter((l) => /근거 확인됨|실무 보완/.test(l)).slice(0, 3).join(' / ')}` : '참고 구역 없음(근거 확인됨·실무 보완 미표시)') : '해당 없음');
  const seal = await ev("document.querySelector('.seal')?.getAttribute('aria-label') ?? ''");
  check('D8', /검증 완료|공식 규정/.test(seal), `인장 '${seal}'`);
}

// S1·S2: 검색 화면 (user)
await login('user');
await go('/search', 5000);
const allN = await ev("document.querySelectorAll('li.entry').length");
check('S1', allN > 0 && /전체 게시 문서/.test(await text()), `검색어 없음 → 카드 ${allN}개`);
await go('/search?q=' + encodeURIComponent('개인정보'), 6000);
const priv = await ev("[...document.querySelectorAll('li.entry h3')].map((h) => h.textContent.slice(0, 30))");
// 검색은 문서 단위로 묶인다(같은 규정의 조문 조각은 카드 1장) → 관련 문서가 1건 이상이고 개인정보 문서가 나오면 통과
check('S2', priv.length >= 1 && priv.some((t) => t.includes('개인정보')), `'개인정보' → ${priv.join(' / ')}`);
await ev("const i = document.querySelector('input[type=search]'); i.focus(); i.select()");
for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
await sleep(5000);
check('S3', (await ev('location.search')) === '' && /전체 게시 문서/.test(await text()), `검색어 지운 뒤 ${await ev('location.pathname + location.search')}`);

writeFileSync(`${OUT}/qa-result.json`, JSON.stringify({ base: BASE, at: new Date().toISOString(), results, page_errors: [...new Set(errors)].slice(0, 20), api_errors: net.filter((n) => n.status >= 400).map((n) => `${n.status} ${new URL(n.url).pathname}`) }, null, 2));
console.log(`\n결과: ${OUT}/qa-result.json`);
ws.close();
process.exit(0);
