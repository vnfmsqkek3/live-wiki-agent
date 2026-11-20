// dev 끝까지 시험 (11/18 저녁): 올리기 → 검토(확인 필요 답·고칠 것) → 게시 요청 → 결재 → 게시 → 정리본 그림 → 수정 요청 → 새 버전 → 다운로드
// 비밀번호는 env QA_PW 로만 받는다. 출력에 비밀번호·토큰·presigned URL 을 남기지 않는다.
// 실행: QA_PW=… QA_BASE=https://<웹 주소> QA_CLIENT=<Cognito 웹 클라이언트 id> node tests/e2e/qa-prod-flow.mjs [저장소 루트] > 결과.log
// 항목 id 는 members/dhxorb96/qa/20261118_prod시험_체크리스트.md 의 '자동' 표와 같다
import { readFileSync, writeFileSync } from 'node:fs';
const BASE = process.env.QA_BASE ?? 'https://d2d8uulvhqvx4w.cloudfront.net';
const P = process.argv[2] ?? '.';
const IN = `${P}/tests/e2e/inputs`;
const results = [];
const check = (id, ok, detail) => { results.push({ id, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${detail}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn, n = 4) { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= n) throw e; await sleep(3000); } } }
const login = await retry(() => fetch('https://cognito-idp.us-east-1.amazonaws.com/', { method: 'POST', headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
  body: JSON.stringify({ AuthFlow: 'USER_PASSWORD_AUTH', ClientId: process.env.QA_CLIENT ?? 'dk963tibatbni7f8j2uhs4afr', AuthParameters: { USERNAME: 'admin', PASSWORD: process.env.QA_PW } }) }));
const tok = (await login.json()).AuthenticationResult.AccessToken;
const api = (m, p, b) => retry(async () => { const x = await fetch(BASE + p, { method: m, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, ...(b ? { body: JSON.stringify(b) } : {}) }); return { s: x.status, j: await x.json().catch(() => null) }; });
async function upload(file, name, title) {
  const bytes = readFileSync(file);
  const u = await api('POST', '/v1/documents/upload-url', { filename: name, size: bytes.length, title, dept: 'QA', acl_groups: ['ALL'] });
  await retry(() => fetch(u.j.url, { method: 'PUT', body: bytes }));
  await api('POST', `/v1/documents/${u.j.doc_id}/analyze`);
  return u.j.doc_id;
}
async function until(id, want = ['IN_REVIEW'], ms = 900_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const d = (await api('GET', `/v1/documents/${id}`)).j; if (want.includes(d?.lifecycle) || d?.workflow_failure) return d; await sleep(15000); }
  return (await api('GET', `/v1/documents/${id}`)).j;
}
async function publish(id) {
  const s = await api('POST', `/v1/documents/${id}/submit`);
  if (s.s >= 300) return { ok: false, why: `submit ${s.s} ${JSON.stringify(s.j).slice(0, 160)}` };
  const ap = (await api('GET', '/v1/approvals')).j.items.find((x) => x.doc_id === id);
  if (!ap) return { ok: false, why: 'approval not found' };
  const dcs = await api('POST', `/v1/approvals/${ap.approval_id}/decision`, { decision: 'APPROVE', reason: '시험 승인 (QA)' });
  if (dcs.s >= 300) return { ok: false, why: `decision ${dcs.s} ${JSON.stringify(dcs.j).slice(0, 160)}` };
  const d = await until(id, ['PUBLISHED'], 600_000);
  return { ok: d.lifecycle === 'PUBLISHED', why: d.lifecycle };
}
const review = async (id) => (await api('GET', `/v1/documents/${id}/review`)).j;

// 1) 올리기
// QA_SKIP_REG=1: 시드 규정(같은 law_id)이 이미 게시돼 있으면 F-001 을 올리지 않는다 (1회차: 시드와 겹쳐 '근거 규정이 바뀌어 재검토' 발생)
const SKIP_REG = process.env.QA_SKIP_REG === '1';
const reg = SKIP_REG ? null : await upload(`${P}/tests/fixtures/documents/pdf/F-001.pdf`, 'F-001.pdf', '[시험] 기업여신 심사규정');
const man = await upload(`${IN}/과천사옥_복합기_스캐너_설치_매뉴얼_12쪽.pdf`, '과천사옥_복합기_스캐너_설치_매뉴얼_12쪽.pdf', '[시험] 과천사옥 복합기 스캐너 설치 매뉴얼');
console.log('uploaded', reg, man);
let d, p, lib;
if (!SKIP_REG) {
  d = await until(reg);
  check('A1', d.lifecycle === 'IN_REVIEW', `규정 분석 → ${d.lifecycle}`);
  // 2) 규정 게시 → 체크리스트는 규정 게시 뒤에 올린다(규정과 비교되게)
  p = await publish(reg); check('A2', p.ok, `규정 게시요청·결재·게시: ${p.why}`);
  lib = (await api('GET', `/v1/library/${reg}`)).j;
  check('A3', !!lib.verification?.checks?.checked_at, `도장 AI 검사 날짜(checked_at) ${lib.verification?.checks?.checked_at ?? '없음'}`);
} else console.log('SKIP A1~A3 (QA_SKIP_REG=1, 시드 규정으로 비교)');
const chk = await upload(`${IN}/QA_여신서류접수체크리스트_SYNTHETIC.docx`, 'QA_여신서류접수체크리스트_SYNTHETIC.docx', '[시험] 기업여신 서류 접수 체크리스트');
await until(chk);
let rv = await review(chk);
const conflicts = (rv.fixes ?? []).filter((f) => f.code === 'KNOWHOW_CONFLICT');
check('B1', conflicts.length > 0, `체크리스트 규정 충돌 ${conflicts.length}건: ${conflicts.map((f) => f.excerpt.slice(0, 30)).join(' / ')}`);
check('B2', (rv.clarify ?? []).length > 0, `확인 필요 ${(rv.clarify ?? []).length}건: ${(rv.clarify ?? []).map((c) => `${c.kind}:${c.item}`).join(', ')}`);
// 3) 확인 필요 답: 담당자류는 부서·직책, 링크는 해당 없음, 값은 30일, 그 밖 해당 없음
let text = rv.text;
const firstClarify = (rv.clarify ?? []).length;
for (const c of rv.clarify ?? []) {
  if (c.status !== 'OPEN') continue;
  const ans = c.kind === 'VAGUE_ACTOR' ? 'IT인프라팀 팀장' : c.kind === 'MISSING_VALUE' && /기한/.test(c.item) ? '30일 이내' : null;
  if (ans) {
    const r = (await api('POST', `/v1/documents/${chk}/clarify/compose`, { answers: [{ finding_id: c.finding_id, answer: ans }] })).j.edits?.[0];
    if (r?.ok && text.includes(c.before)) { text = text.replace(c.before, r.after); check('C1', true, `답 넣기 '${ans}' → ${r.after.slice(0, 50)}`); continue; }
    check('C1', false, `답 넣기 '${ans}' 실패: ${r?.reason ?? ''} / 본문에 원래 문장 ${text.includes(c.before)}`);
  }
  const a = await api('POST', `/v1/documents/${chk}/findings/${c.finding_id}/ack`, { reason: '시험: 해당 없음' });
  check('C2', a.s === 200, `해당 없음 ${c.item} → ${a.s}`);
}
// 고칠 것: 제안대로 고치기 (본문에서 찾아 바꿈)
for (const f of conflicts) {
  if (f.suggestion && text.includes(f.excerpt)) { text = text.replace(f.excerpt, f.suggestion); check('C3', true, `제안대로 고침: ${f.suggestion.slice(0, 40)}`); }
  else check('C3', false, `제안 적용 불가(문장 못 찾음): ${f.excerpt.slice(0, 40)}`);
}
const ed = await api('POST', `/v1/documents/${chk}/edit`, { markdown: text });
check('C4', ed.s === 201, `저장하고 검사받기 → ${ed.s}`);
await until(chk);
rv = await review(chk);
const openFix = (rv.fixes ?? []).filter((f) => !f.acknowledged);
const newClarify = (rv.clarify ?? []).filter((c) => c.status === 'OPEN');
check('D1', newClarify.length === 0, `재검사 뒤 열린 확인 필요 ${newClarify.length}건 (처음 ${firstClarify}건): ${newClarify.map((c) => c.item).join(', ')}`);
check('D2', openFix.length === 0, `재검사 뒤 남은 고칠 것 ${openFix.length}건: ${openFix.map((f) => f.excerpt.slice(0, 30)).join(' / ')}`);
check('D3', (rv.clarify ?? []).filter((c) => c.status === 'DISMISSED').length >= 1 || firstClarify === 0, `해당 없음 결정 이어짐 ${(rv.clarify ?? []).filter((c) => c.status === 'DISMISSED').length}건`);
for (const f of openFix) { const a = await api('POST', `/v1/documents/${chk}/findings/${f.finding_id}/ack`, { reason: '시험: 승인자 판단 요청' }); check('D4', a.s === 200, `남은 고칠 것 그대로 사용(사유) → ${a.s}`); }
p = await publish(chk); check('D5', p.ok, `체크리스트 게시: ${p.why}`);

// 4) 매뉴얼: 확인 필요 답(no_change 포함)·개인정보 그림 확인·저장 → 게시 → 정리본 그림
await until(man);
rv = await review(man);
text = rv.text;
for (const c of rv.clarify ?? []) {
  if (c.status !== 'OPEN') continue;
  if (c.kind === 'INCONSISTENT') {
    const r = (await api('POST', `/v1/documents/${man}/clarify/compose`, { answers: [{ finding_id: c.finding_id, answer: '다른모델임' }] })).j.edits?.[0];
    check('E1', !!r?.no_change, `'다른모델임' → no_change=${!!r?.no_change} ok=${r?.ok} ${r?.reason ?? ''}`);
    await api('POST', `/v1/documents/${man}/findings/${c.finding_id}/ack`, { reason: '확인함: 다른모델임' });
    continue;
  }
  check('E2', text.includes(c.before), `확인 필요 문장이 편집 글에 있음(${c.item}, ${c.page}쪽): ${text.includes(c.before)}`);
  if (c.kind === 'MISSING_LINK' && text.includes(c.before)) { text = text.replace(c.before, `${c.before} (https://www.samsungsvc.co.kr/download)`); continue; }
  await api('POST', `/v1/documents/${man}/findings/${c.finding_id}/ack`, { reason: '시험: 해당 없음' });
}
const reviews = (rv.reviews ?? []).filter((x) => !x.acknowledged).map((x) => x.finding_id);
if (reviews.length) { const a = await api('POST', `/v1/documents/${man}/findings/ack`, { finding_ids: reviews, reason: '시험: 가상 데이터, 그림 속 개인정보 없음' }); check('E3', a.s === 200, `그림 개인정보 확인 ${reviews.length}건 → ${a.s}`); }
const figBefore = (text.match(/그림 \d+-\d+/g) ?? []).length;
const ed2 = await api('POST', `/v1/documents/${man}/edit`, { markdown: text });
check('E4', ed2.s === 201, `매뉴얼 저장(링크 넣기) → ${ed2.s}, 편집 글 그림 표시 ${figBefore}곳`);
await until(man);
rv = await review(man);
const left = [...(rv.fixes ?? []).filter((f) => !f.acknowledged), ...(rv.clarify ?? []).filter((c) => c.blocking && c.status === 'OPEN'), ...(rv.reviews ?? []).filter((x) => !x.acknowledged)];
check('E5', left.length === 0, `매뉴얼 재검사 뒤 남은 일 ${left.length}건`);
for (const x of (rv.reviews ?? []).filter((y) => !y.acknowledged)) await api('POST', `/v1/documents/${man}/findings/ack`, { finding_ids: [x.finding_id], reason: '시험' });
p = await publish(man); check('E6', p.ok, `매뉴얼 게시: ${p.why}`);
lib = (await api('GET', `/v1/library/${man}`)).j;
const figs = (lib.pages ?? []).flatMap((pg) => pg.figures ?? []);
const withUrl = figs.filter((f) => f.url).length;
check('E7', withUrl > 0, `정리본 그림 ${withUrl}/${figs.length}개 주소 있음 (키 예: ${figs.slice(0, 3).map((f) => f.k).join(',')})`);
const st = (lib.pages ?? []).map((pg) => pg.structured ?? pg.text).join('\n');
const refs = [...new Set(st.match(/그림 \d+-\d+/g) ?? [])];
const resolved = refs.filter((r) => figs.some((f) => f.url && `그림 ${f.k}` === r)).length;
check('E8', refs.length > 0 && resolved > 0, `정리본 그림 표시 ${refs.length}곳 중 그림 연결 ${resolved}곳`);
check('E9', !!lib.verification?.checks?.checked_at, `매뉴얼 도장 AI 검사 날짜 ${lib.verification?.checks?.checked_at ?? '없음'}`);
// 5) 다운로드
const dl = await api('GET', `/v1/library/${man}/download`);
check('F1', dl.s === 200 && /_수정본\.md$/.test(dl.j?.filename ?? ''), `수정본 다운로드 이름 ${dl.j?.filename}`);
const dlo = await api('GET', `/v1/library/${man}/download?kind=original`);
check('F2', dlo.s === 200 && /\.pdf$/.test(dlo.j?.filename ?? ''), `처음 올린 원본 다운로드 이름 ${dlo.j?.filename}`);
if (dlo.s === 200) { const h = await retry(() => fetch(dlo.j.url, { method: 'GET', headers: { range: 'bytes=0-4' } })); check('F3', [200, 206].includes(h.status) && (await h.text()).startsWith('%PDF'), `원본 파일 내려받기 ${h.status}`); }
// 6) 수정 요청 → 관리자 반영 → 새 버전 → 이미 답한 확인 필요가 다시 나오지 않음
lib = (await api('GET', `/v1/library/${chk}`)).j;
const chkText = (await review(chk))?.text ?? (lib.pages ?? []).map((pg) => pg.structured ?? pg.text).join('\n');
const target = chkText.split('\n').map((l) => l.trim()).find((l) => /서류|접수/.test(l) && l.length > 10 && !l.startsWith('|') && !l.startsWith('#'));
const cr = await api('POST', `/v1/documents/${chk}/change-requests`, { before: target, request: '접수 담당 부서가 여신지원부로 바뀌었습니다. 부서 이름을 여신지원부로 고쳐 주세요.' });
check('G1', cr.s === 201, `수정 요청 → ${cr.s} AI ${cr.j?.verdict} ${cr.j?.after?.slice(0, 40) ?? ''} ${cr.j?.ai_reason?.slice(0, 60) ?? ''}`);
if (cr.s === 201) {
  const apl = await api('POST', `/v1/admin/change-requests/${chk}/${cr.j.id}`, { decision: 'APPLY', after: cr.j.after ?? `${target} (여신지원부)` });
  check('G2', apl.s === 200 && !!apl.j?.new_doc_id, `관리자 반영 → 새 버전 ${apl.j?.new_doc_id ?? apl.s}`);
  if (apl.j?.new_doc_id) {
    await until(apl.j.new_doc_id);
    rv = await review(apl.j.new_doc_id);
    const reOpen = (rv.clarify ?? []).filter((c) => c.status === 'OPEN');
    check('G3', reOpen.length === 0, `새 버전 열린 확인 필요 ${reOpen.length}건 ${reOpen.map((c) => c.item).join(', ')}`);
    const nf = (rv.fixes ?? []).filter((f) => !f.acknowledged);
    check('G4', nf.length === 0, `새 버전 막는 고칠 것 ${nf.length}건 ${nf.map((f) => f.excerpt.slice(0, 30)).join(' / ')}`);
  }
}
const pass = results.filter((r) => r.ok).length;
console.log(`\n결과 ${pass}/${results.length} 통과`);
console.log(JSON.stringify({ reg, chk, man }));
if (process.env.QA_OUT) writeFileSync(process.env.QA_OUT, JSON.stringify({ base: BASE, at: new Date().toISOString(), pass, total: results.length, results, docs: { reg, chk, man } }, null, 2));
