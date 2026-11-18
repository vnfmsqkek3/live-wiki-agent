// dev 끝까지 시험 (11/18 저녁): 올리기 → 검토(확인 필요 답·고칠 것) → 게시 요청 → 결재 → 게시 → 정리본 그림 → 수정 요청 → 새 버전 → 다운로드
// 비밀번호는 env QA_PW 로만 받는다. 출력에 비밀번호·토큰·presigned URL 을 남기지 않는다.
// 실행: QA_PW=… QA_BASE=https://<웹 주소> QA_CLIENT=<Cognito 웹 클라이언트 id> node tests/e2e/qa-prod-flow.mjs [저장소 루트] > 결과.log
// H16 (노하우 재검증) 전용. 빈 prod 에서 맨 먼저 실행 (members/dhxorb96/qa/20261118_prod시험_체크리스트.md 2회차 ①)
import { readFileSync, writeFileSync } from 'node:fs';
const BASE = process.env.QA_BASE ?? 'https://d3k1kbwh1nvr8d.cloudfront.net';
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
// H16: 노하우를 규정보다 먼저 게시 → 규정 게시 → 노하우가 '재검토 필요'(근거 규정과 다시 비교)로 바뀌는가. 끝나면 노하우 삭제(규정은 유지)
const chk = await upload(`${IN}/QA_여신서류접수체크리스트_SYNTHETIC.docx`, 'QA_여신서류접수체크리스트_SYNTHETIC.docx', '[시험] 기업여신 서류 접수 체크리스트');
await until(chk);
let rv = await review(chk);
if ((rv.classification?.document_type ?? '') !== 'KNOWHOW') { // AI 가 매뉴얼로 분류하면 노하우로 (종류 바꾸면 다시 분석)
  await api('POST', `/v1/documents/${chk}/classification`, { document_type: 'KNOWHOW', reason: '실무 체크리스트(노하우) — H16 시험' });
  await sleep(20000); await until(chk); rv = await review(chk);
}
const noBasis = (rv.findings ?? []).some((f) => f.code === 'KNOWHOW_NO_BASIS');
check('H16-1', noBasis, `규정 없을 때 노하우 '근거 규정 없음' 표시: ${noBasis}`);
for (const c of (rv.clarify ?? []).filter((x) => x.status === 'OPEN' && x.blocking)) await api('POST', `/v1/documents/${chk}/findings/${c.finding_id}/ack`, { reason: 'H16 시험' });
let p = await publish(chk); check('H16-2', p.ok, `노하우 먼저 게시: ${p.why}`);
let lib = (await api('GET', `/v1/library/${chk}`)).j;
check('H16-3', lib.freshness === 'CURRENT', `규정 게시 전 노하우 상태 ${lib.freshness}`);
const reg = await upload(`${P}/tests/fixtures/documents/pdf/F-001.pdf`, 'F-001.pdf', '[시험] 기업여신 심사규정');
await until(reg);
p = await publish(reg); check('H16-4', p.ok, `규정 게시: ${p.why}`);
let fr = 'CURRENT';
for (let i = 0; i < 20 && fr === 'CURRENT'; i++) { await sleep(15000); fr = (await api('GET', `/v1/library/${chk}`)).j.freshness; }
check('H16-5', fr === 'REVIEW_REQUIRED', `규정 게시 뒤 노하우 상태 ${fr} (재검증)`);
const del = await api('DELETE', `/v1/documents/${chk}`, { reason: 'H16 시험 끝, J1 오염 방지' });
check('H16-6', del.s === 202, `시험 노하우 삭제 ${del.s} (규정 ${reg} 는 유지)`);
const pass = results.filter((r) => r.ok).length;
console.log(`\n결과 ${pass}/${results.length} 통과`);
console.log(JSON.stringify({ reg, chk }));
if (process.env.QA_OUT) writeFileSync(process.env.QA_OUT, JSON.stringify({ base: BASE, at: new Date().toISOString(), pass, total: results.length, results, docs: { reg, chk } }, null, 2));
