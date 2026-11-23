// 문서보관함: 권한 범위, 연관 문서(권한 밖 제외), 페이지·요약·밑줄 조합, 필터
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, type Deps } from '../src/app.ts';
import { memoryStore } from '../src/store.ts';
import { ApiError } from '../src/errors.ts';
import type { Actor, DocumentRecord } from '../src/contracts.ts';

const USERS: Record<string, Actor> = {
  author: { sub: 'u-author', groups: ['AUTHOR'], dept: 'loan' },
  user: { sub: 'u-user', groups: ['USER'], dept: 'loan' },
  approver: { sub: 'u-appr', groups: ['REG_APPROVER'], dept: 'loan' },
};
const base = (o: Partial<DocumentRecord> & { doc_id: string }): DocumentRecord => ({
  version: 1, owner: 'u-other', title: o.doc_id, dept: 'loan', acl_groups: ['ALL'], ext: 'pdf', lifecycle: 'PUBLISHED',
  authority_status: 'VERIFIED', freshness: 'CURRENT', findings: [], created_at: '2026-11-16', updated_at: '2026-11-16', ...o,
});
const item = (provision_id: string, relation: 'SUPPORTS' | 'CONFLICTS' | 'INSUFFICIENT', verified_quote = true) =>
  ({ statement: 's', provision_id, label: `라벨 ${provision_id}`, relation, reason: 'r', quote: 'q', verified_quote });

async function setup() {
  const store = memoryStore();
  const deleted: string[] = [];
  const searched: unknown[] = [];
  let pagesFn = (id: string): { page: number; text: string }[] => id ? [{ page: 1, text: '둘째 장' }, { page: 0, text: '1억원 이하는 현장 실사를 생략한다.' }] : [];
  await store.putDoc(base({ doc_id: 'REG', title: '기업여신 심사규정', law_id: 'SYN-LOAN-001', revision_id: '2026-11-01', document_type: 'REGULATION', classification: { document_type: 'REGULATION', business_path: ['여신'], tags: ['공식규정'], confidence: 1, rationale: '' } }));
  await store.putDoc(base({ doc_id: 'REG_NEXT', title: '기업여신 심사규정 (12-01 개정)', law_id: 'SYN-LOAN-001', revision_id: '2026-12-01', document_type: 'REGULATION' }));
  await store.putDoc(base({ doc_id: 'SECRET', title: '권한 밖 규정', law_id: 'SYN-HR-001', acl_groups: ['DEPT#hr'] }));
  await store.putDoc(base({
    doc_id: 'KH', title: '소액 담보 팁', document_type: 'KNOWHOW', authority_status: 'UNVERIFIED', summary: '요약문',
    page_summaries: [{ page: 0, summary: '첫 장 요약' }],
    classification: { document_type: 'KNOWHOW', business_path: ['여신', '담보'], tags: ['실무사례'], confidence: 0.9, rationale: '' },
    knowhow_validation: { verdict: 'CONFLICT', model: 'm', checked_at: '2026-11-16', outdated: [], items: [item('SYN-LOAN-001@2026-11-01/ARTICLE:14', 'CONFLICTS'), item('SYN-HR-001@2026-11-01/ARTICLE:1', 'CONFLICTS'), item('SYN-LOAN-001@2026-11-01/ARTICLE:9', 'INSUFFICIENT', false)] },
  }));
  await store.putDoc(base({ doc_id: 'DRAFT', owner: 'u-author', lifecycle: 'IN_REVIEW', authority_status: 'UNVERIFIED' }));
  await store.putDoc(base({ doc_id: 'OTHERS_DRAFT', lifecycle: 'IN_REVIEW' }));
  await store.putDoc(base({ doc_id: 'BLOCKED_DOC', lifecycle: 'BLOCKED', findings: [{ finding_id: 'f1', step: 'FILE_STRUCTURE', severity: 'HIGH', code: 'PDF_JAVASCRIPT', message: 'js', user_message: '스크립트가 들어 있습니다', fix_hint: '다시 저장', evidence_ref: 'x', location: { page: 2 } }] }));
  const deps = {
    verify: async (t: string) => { const u = USERS[t]; if (!u) throw new ApiError('UNAUTHORIZED', 'x'); return u; },
    store, presignPut: async () => '', headObject: async () => undefined, startWorkflow: async () => {}, resume: async () => true,
    search: async (_q: string, _a: unknown, o: unknown) => { searched.push(o); return []; }, guide: async () => ({}),
    presignGet: async (key: string, v: string | undefined, name: string) => `https://s3/${key}?v=${v}&n=${name}`,
    deleteWorkflow: async (d: DocumentRecord) => { deleted.push(d.delete_workflow_id!); },
    pages: async (id: string) => pagesFn(id),
    pageSummary: async (id: string) => id === 'KH' ? { pages: [{ page_index: 1, summary: '둘째 장 요약', keywords: ['현장 실사'], clause_refs: ['제14조'], page_type: '본문' }] } : undefined,
    marks: async () => [{ page: 0, start: 0, end: 5, severity: 'HIGH', kind: 'CONFLICT', reason: '실사 의무' }, { page: null, start: null, end: null, severity: 'HIGH', kind: 'REGISTRY_MISMATCH', reason: '조문 누락' }],
  } as Deps;
  const app = createApp(deps);
  const get = (who: string, path: string) => app.request(path, { headers: { authorization: `Bearer ${who}` } });
  const del = (who: string, path: string, reason = '중복 문서') => app.request(path, { method: 'DELETE', headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' }, body: JSON.stringify({ reason }) });
  const post = (who: string, path: string, b: unknown) => app.request(path, { method: 'POST', headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' }, body: JSON.stringify(b) });
  return { get, del, post, store, deleted, searched, setPages: (f: typeof pagesFn) => { pagesFn = f; } };
}

test('목록: 권한 내 게시 문서 + 본인 문서만, 타인 미게시·권한 밖 제외', async () => {
  const t = await setup();
  const ids = ((await (await t.get('author', '/v1/library')).json()) as { items: { doc_id: string }[] }).items.map((i) => i.doc_id).sort();
  assert.deepEqual(ids, ['DRAFT', 'KH', 'REG']); // 같은 law_id의 개정본(REG_NEXT, 시행 전)은 REG 카드 하나로 묶임
});

test('카드: 요약·태그·연관(권한 밖 규정 제외)·밑줄 수(대조 통과분만)', async () => {
  const t = await setup();
  const { items } = (await (await t.get('user', '/v1/library')).json()) as { items: { doc_id: string; summary: string; tags: string[]; mark_count: number; related: { doc_id: string; relation: string }[] }[] };
  const kh = items.find((i) => i.doc_id === 'KH')!;
  assert.equal(kh.summary, '요약문');
  assert.equal((kh as unknown as { uploaded_at: string }).uploaded_at, '2026-11-16');
  assert.deepEqual(kh.tags, ['실무사례']);
  assert.deepEqual(kh.related.map((r) => [r.doc_id, r.relation]), [['REG', 'CONFLICTS']]);
  assert.equal(kh.mark_count, 2); // CONFLICTS 2건(대조 통과), INSUFFICIENT는 대조 실패라 제외
  const reg = items.find((i) => i.doc_id === 'REG')!;
  assert.deepEqual(reg.related.map((r) => [r.doc_id, r.relation]), [['KH', 'CONFLICTS']]);
});

test('필터: 유형·업무·태그·검색어', async () => {
  const t = await setup();
  const ids = async (q: string) => ((await (await t.get('user', `/v1/library?${q}`)).json()) as { items: { doc_id: string }[] }).items.map((i) => i.doc_id);
  assert.deepEqual(await ids('type=KNOWHOW'), ['KH']);
  assert.deepEqual(await ids('business=담보'), ['KH']);
  assert.deepEqual(await ids('tag=공식규정'), ['REG']);
  assert.deepEqual(await ids(`q=${encodeURIComponent('요약문')}`), ['KH']);
});

test('상세: 페이지 순서·페이지 요약·밑줄, 권한 밖·타인 미게시는 404', async () => {
  const t = await setup();
  const d = (await (await t.get('user', '/v1/library/KH')).json()) as { doc_marks: { kind: string }[]; pages: { page: number; summary: string | null; marks: { kind: string }[] }[] };
  assert.deepEqual(d.pages.map((p) => p.page), [0, 1]);
  assert.equal(d.pages[0]!.summary, '첫 장 요약');
  assert.equal(d.pages[0]!.marks[0]!.kind, 'CONFLICT');
  assert.equal(d.pages[1]!.summary, '둘째 장 요약'); // PageSummarize 결과(masked/summary.json)
  assert.deepEqual((d.pages[1] as unknown as { clause_refs: string[] }).clause_refs, ['제14조']);
  assert.equal(d.pages[1]!.marks.length, 0);
  assert.deepEqual(d.doc_marks.map((m) => m.kind), ['REGISTRY_MISMATCH']);
  assert.equal((await t.get('user', '/v1/library/SECRET')).status, 404);
  assert.equal((await t.get('user', '/v1/library/OTHERS_DRAFT')).status, 404);
});

test('상세 검증 정보: 문서 표기 일자, 노하우 비교 조문·승인자·시각, 매뉴얼은 사람 승인 방식', async () => {
  const { docDatesOf, verification } = await import('../src/library.ts');
  const base = { doc_id: 'X', version: 1, owner: 'o', title: 't', dept: 'd', acl_groups: ['ALL'], ext: 'pdf', lifecycle: 'PUBLISHED' as const, authority_status: 'VERIFIED' as const, freshness: 'CURRENT' as const, findings: [], created_at: '', updated_at: '' };
  // 저장된 일자가 없는 이전 문서는 쪽 본문에서 찾는다, 저장된 일자가 있으면 그대로
  assert.deepEqual(docDatesOf(base, [{ page: 3, text: '문서 관리번호 05\n개정일 / 버전 2026.10.15 / 1.0\n시행일 2026. 12. 1.' }]).doc_date, { label: '시행일', date: '2026-12-01' });
  assert.equal(docDatesOf(base, [{ page: 3, text: '개정일 2026.10.15' }]).doc_dates[0]!.page, 3);
  assert.deepEqual(docDatesOf({ ...base, doc_dates: [{ kind: '작성', date: '2026-01-02', page: 0 }], doc_date: { kind: '작성', date: '2026-01-02', page: 0 } }, []).doc_date, { label: '작성일', date: '2026-01-02' });
  const v = verification({ ...base, document_type: 'KNOWHOW', knowhow_validation: { verdict: 'SUPPORTED', model: 'm', checked_at: 'c', outdated: [], items: [{ statement: 's', provision_id: 'p', label: '기업여신 심사규정 제10조제2항', relation: 'SUPPORTS', reason: 'r', quote: '6개월 이내', verified_quote: true }] } },
    { approver_sub: 'abcdefgh123', approver_name: 'admin', decided_at: '2026-11-17T01:00:00Z', reason: '확인' });
  assert.equal(v.approved_by, 'admin');
  assert.equal(v.basis[0]!.label, '기업여신 심사규정 제10조제2항');
  assert.equal(v.basis[0]!.result, '근거 확인됨(규정과 일치)');
  assert.match(verification({ ...base, document_type: 'MANUAL' }).method, /사람 승인/);
  assert.equal(verification({ ...base, document_type: 'MANUAL' }, { approver_sub: 'abcdefgh123' }).approved_by, '관리자 계정(abcdefgh)');
});

test('상호 보완: 매뉴얼 인용(citations)으로 규정과 연결, 규정 쪽에서 매뉴얼이 CITED_BY, 비슷한 다른 유형 문서', async () => {
  const { related, similar } = await import('../src/library.ts');
  const b = { version: 1, owner: 'o', dept: 'd', acl_groups: ['ALL'], ext: 'pdf', lifecycle: 'PUBLISHED' as const, authority_status: 'VERIFIED' as const, freshness: 'CURRENT' as const, findings: [], created_at: '', updated_at: '' };
  const reg = { ...b, doc_id: 'R', title: '개인정보 보호규정', document_type: 'REGULATION' as const, law_id: 'SYN-PRIV-001', revision_id: '2026-11-01' };
  const man = { ...b, doc_id: 'M', title: '개인정보 수집 매뉴얼', document_type: 'MANUAL' as const, citations: [{ provision_id: 'SYN-PRIV-001@2026-11-01/ARTICLE:5', evidence_span: '개인정보 보호규정 제5조', confidence: 0.95 }] };
  const kh = { ...b, doc_id: 'K', title: '고객정보 처리 팁', document_type: 'KNOWHOW' as const };
  const vis = [reg, man, kh];
  assert.deepEqual(related(man, vis).map((r) => [r.doc_id, r.relation, r.document_type]), [['R', 'CITES', 'REGULATION']]);
  assert.deepEqual(related(reg, vis).map((r) => [r.doc_id, r.relation, r.document_type]), [['M', 'CITED_BY', 'MANUAL']]);
  const s = similar(man, [{ doc_id: 'M', title: 'x' }, { doc_id: 'R', title: 'x' }, { doc_id: 'K', title: 'x' }], vis, related(man, vis));
  assert.deepEqual(s.map((r) => [r.doc_id, r.relation, r.reason]), [['K', 'SIMILAR', '내용이 비슷한 노하우']]);
});

test('결재함에서 연 문서: 관리자는 남의 게시 전·차단 문서 상세와 확인 이유를 본다, 일반 사용자는 404, 목록에는 안 섞임', async () => {
  const t = await setup();
  const r = await t.get('approver', '/v1/library/BLOCKED_DOC');
  assert.equal(r.status, 200);
  const d = (await r.json()) as { review: { lifecycle: string; findings: { message: string; fix_hint: string; page: number }[] } };
  assert.equal(d.review.lifecycle, 'BLOCKED');
  assert.deepEqual(d.review.findings[0], { severity: 'HIGH', code: 'PDF_JAVASCRIPT', step: 'FILE_STRUCTURE', message: '스크립트가 들어 있습니다', fix_hint: '다시 저장', page: 2 });
  assert.equal((await t.get('approver', '/v1/library/OTHERS_DRAFT')).status, 200);
  assert.equal((await t.get('approver', '/v1/library/BLOCKED_DOC/similar')).status, 200); // 하위 조회도 같은 권한
  assert.equal((await t.get('user', '/v1/library/BLOCKED_DOC/similar')).status, 404);
  assert.equal((await t.get('user', '/v1/library/BLOCKED_DOC')).status, 404);
  assert.equal((await t.get('user', '/v1/library/OTHERS_DRAFT')).status, 404);
  const ids = ((await (await t.get('approver', '/v1/library')).json()) as { items: { doc_id: string }[] }).items.map((i) => i.doc_id);
  assert.ok(!ids.includes('BLOCKED_DOC') && !ids.includes('OTHERS_DRAFT'));
  const pub = (await (await t.get('approver', '/v1/library/KH')).json()) as { review?: unknown };
  assert.equal(pub.review, undefined); // 게시본에는 결재 정보 없음
});

test('문서 삭제: 작성자 본인·관리자만, DELETED·사유·감사 후 정리 실행(새 workflow), 다시 누르면 정리만 재시도, 보관함에서 사라짐', async () => {
  const t = await setup();
  assert.equal((await t.del('user', '/v1/library/DRAFT'.replace('library', 'documents'))).status, 404); // 남의 게시 전 문서
  assert.equal((await t.del('user', '/v1/documents/KH')).status, 403); // 게시본은 보이지만 작성자 아님
  const r = await t.del('author', '/v1/documents/DRAFT');
  assert.equal(r.status, 202);
  const d = (await t.store.getDoc('DRAFT'))!;
  assert.deepEqual([d.lifecycle, d.deleted_reason, d.deleted_by], ['DELETED', '중복 문서', 'u-author']);
  assert.equal(t.deleted.length, 1);
  assert.equal(t.deleted[0], d.delete_workflow_id);
  assert.equal(t.store.audits.at(-1)!.action, 'DOCUMENT_DELETE');
  assert.equal((await t.del('author', '/v1/documents/DRAFT', '다른 사유')).status, 202);
  assert.equal(t.deleted.length, 2);
  assert.notEqual(t.deleted[1], t.deleted[0]);
  assert.equal((await t.store.getDoc('DRAFT'))!.deleted_reason, '중복 문서'); // 처음 사유 유지
  assert.equal((await t.del('approver', '/v1/documents/KH')).status, 202);
  const ids = ((await (await t.get('user', '/v1/library')).json()) as { items: { doc_id: string }[] }).items.map((i) => i.doc_id);
  assert.ok(!ids.includes('KH'));
  assert.equal((await t.del('author', '/v1/documents/DRAFT', ' ')).status, 422); // 사유 필수 (VALIDATION)
  assert.equal((await t.del('author', '/v1/documents/REG')).status, 403);
  // 사용자 결정 11/23: 작성자는 게시 전만. 자기 게시 문서는 403·can_delete false, 결재자는 삭제 가능
  await t.store.putDoc({ ...(await t.store.getDoc('KH'))!, doc_id: 'MINE_PUB', owner: 'u-author', lifecycle: 'PUBLISHED' });
  assert.equal(((await (await t.get('author', '/v1/library/MINE_PUB')).json()) as { can_delete: boolean }).can_delete, false);
  const own = await t.del('author', '/v1/documents/MINE_PUB');
  assert.equal(own.status, 403);
  assert.match(((await own.json()) as { error: { message: string } }).error.message, /결재자만/);
  assert.equal(((await (await t.get('approver', '/v1/library/MINE_PUB')).json()) as { can_delete: boolean }).can_delete, true);
  assert.equal((await t.del('approver', '/v1/documents/MINE_PUB')).status, 202);
});

test('원본 내려받기: 상세를 볼 수 있는 사람만, 승인된 버전·파일 이름, 감사 기록 / 권한 밖·원본 삭제 문서는 404', async () => {
  const t = await setup();
  await t.store.putDoc({ ...(await t.store.getDoc('KH'))!, filename: '소액담보팁.pdf', s3_version_id: 'v7' });
  const r = await t.get('user', '/v1/library/KH/download');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { url: 'https://s3/KH/original.pdf?v=v7&n=소액담보팁.pdf', filename: '소액담보팁.pdf' });
  assert.equal(t.store.audits.at(-1)!.action, 'DOCUMENT_DOWNLOAD');
  assert.equal((await t.get('user', '/v1/library/SECRET/download')).status, 404);
  await t.store.putDoc({ ...(await t.store.getDoc('KH'))!, purge: { objects: 2, original_at: '2026-11-17' } });
  assert.equal((await t.get('user', '/v1/library/KH/download')).status, 404);
});

test('버전: 작성자가 이전 버전 후보를 보고 연결 → v2, 바뀐 곳(조문 단위), 묶음 버전 목록, 게시 전에만 연결 변경', async () => {
  const t = await setup();
  const pagesOf: Record<string, string> = {
    V1: '여신 금액 처리 요령\n1. 여신 금액이 7억원 이상이면 본부 승인을 받는다.\n2. 감정평가서는 6개월 이내의 것을 쓴다.',
    V2: '여신 금액 처리 요령\n1. 여신 금액이 5억원 이상이면 본부 승인을 받는다.\n2. 감정평가서는 6개월 이내의 것을 쓴다.\n3. 실사 사진을 첨부한다.',
  };
  await t.store.putDoc(base({ doc_id: 'V1', title: '여신 금액 처리 요령', document_type: 'KNOWHOW' }));
  await t.store.putDoc(base({ doc_id: 'V2', owner: 'u-author', title: '여신 금액 처리 요령', document_type: 'KNOWHOW', lifecycle: 'IN_REVIEW', authority_status: 'UNVERIFIED' }));
  t.setPages((id) => [{ page: 0, text: pagesOf[id] ?? '' }]);
  const cands = (await (await t.get('author', '/v1/documents/V2/version-candidates')).json()) as { items: { doc_id: string; reason: string }[] };
  assert.equal(cands.items[0]!.doc_id, 'V1');
  assert.match(cands.items[0]!.reason, /제목 같음/);
  const link = await t.post('author', '/v1/documents/V2/previous', { previous_doc_id: 'V1' });
  assert.equal(link.status, 200);
  const v2 = (await t.store.getDoc('V2'))!;
  assert.deepEqual([v2.series_id, v2.version_no, v2.previous_doc_id], ['V1', 2, 'V1']);
  const vs = (await (await t.get('author', '/v1/library/V2/versions')).json()) as { items: { doc_id: string; version_no: number }[]; diff: { count: number; changes: { kind: string; new_text: string }[] } };
  assert.deepEqual(vs.items.map((i) => [i.doc_id, i.version_no]), [['V1', 1], ['V2', 2]]);
  assert.ok(vs.diff.count >= 2);
  assert.ok(vs.diff.changes.some((x) => x.kind === 'CHANGED' && x.new_text.includes('5억원')));
  assert.ok(vs.diff.changes.some((x) => x.kind === 'ADDED' && x.new_text.includes('실사 사진')));
  assert.equal((await t.post('user', '/v1/documents/V2/previous', { previous_doc_id: null })).status, 404); // 남의 게시 전 문서
  await t.store.putDoc({ ...(await t.store.getDoc('V2'))!, lifecycle: 'PENDING_APPROVAL' });
  assert.equal((await t.post('author', '/v1/documents/V2/previous', { previous_doc_id: null })).status, 409);
});

test('세부 필터: 보관함·검색 모두 업무·부서·문서 일자·검증 상태·최신성, 검색은 search_wiki에 그대로, 틀린 형식은 버림', async () => {
  const t = await setup();
  await t.store.putDoc({ ...(await t.store.getDoc('KH'))!, doc_date: { kind: '시행', date: '2026-11-01', page: 0 } });
  const ids = async (q: string) => ((await (await t.get('user', `/v1/library?${q}`)).json()) as { items: { doc_id: string }[] }).items.map((i) => i.doc_id).sort();
  assert.deepEqual(await ids('authority_status=UNVERIFIED'), ['KH']);
  assert.deepEqual(await ids('date_from=2026-10-01&date_to=2026-11-30'), ['KH']);
  assert.deepEqual(await ids('date_from=2026-11-02'), []);
  assert.deepEqual(await ids('business=여신&freshness=CURRENT'), ['KH', 'REG']);
  assert.ok((await ids('date_from=bad')).length > 1); // 형식이 틀리면 필터 없음
  const r = await t.get('user', `/v1/search?q=${encodeURIComponent('소액 담보')}&dept=loan&date_from=2026-10-01&authority_status=UNVERIFIED&freshness=XX`);
  assert.deepEqual((await r.json() as { items: { doc_id: string }[] }).items.map((i) => i.doc_id), ['KH']); // 키워드 보완도 같은 조건
  assert.deepEqual(t.searched.at(-1), { tags: [], as_of: undefined, dept: 'loan', date_from: '2026-10-01', authority_status: 'UNVERIFIED' });
});

test('검색 related(근거로 확인되지 않은 관련 문서): items와 나눠 related로, 이미 보인 문서·다른 종류는 빼고 (let522mj PR #22)', async () => {
  const { searchVia } = await import('../src/search.ts');
  const hit = (doc_id: string, document_type = 'REGULATION') => ({ doc_id, title: doc_id, snippet: 's', effective_from: '', authority_status: 'VERIFIED', freshness: 'CURRENT', search_status: 'FOUND', document_type });
  const s = searchVia(async () => ({ items: [hit('A')], related: [{ ...hit('B'), search_status: 'UNVERIFIED' }, { ...hit('A') }] }));
  const out = await s('q', { sub: 'u', groups: ['USER'] }, { tags: [] }) as { doc_id: string; weak?: boolean }[];
  assert.deepEqual(out.map((x) => [x.doc_id, !!x.weak]), [['A', false], ['B', true], ['A', true]]);
});

test('한 규정 = 한 문서: 같은 law_id 개정본은 카드 1장(오늘 시행 중인 판이 대표, 버전 수), 상세에서 버전 목록·직전 판과 바뀐 곳 (사용자 지적 11/17)', async () => {
  const t = await setup();
  const { items } = (await (await t.get('user', '/v1/library?type=REGULATION')).json()) as { items: { doc_id: string; version_count: number }[] };
  assert.deepEqual(items.map((i) => [i.doc_id, i.version_count]), [['REG', 2]]);
  t.setPages((id) => [{ page: 0, text: id === 'REG_NEXT' ? '제12조(승인) ① 여신 금액이 3억원 이상인 경우 본부 승인을 받아야 한다.\n제13조 a\n제14조 b' : '제12조(승인) ① 여신 금액이 5억원 이상인 경우 본부 승인을 받아야 한다.\n제13조 a\n제14조 b' }]);
  const v = (await (await t.get('user', '/v1/library/REG_NEXT/versions')).json()) as { items: { doc_id: string; version_no: number; current: boolean }[]; diff: { previous: { doc_id: string; version_no: number }; count: number } };
  assert.deepEqual(v.items.map((i) => [i.doc_id, i.version_no, i.current]), [['REG', 1, true], ['REG_NEXT', 2, false]]);
  assert.equal(v.diff.previous.doc_id, 'REG');
  assert.ok(v.diff.count >= 1);
});

test('검색 결과 문서 단위: 같은 문서의 조문 조각은 카드 1장 + 맞은 조문 목록, 순서는 문서의 최고 순위 (사용자 지적 11/17)', async () => {
  const { groupByDoc } = await import('../src/search.ts');
  const h = (doc_id: string, basis: string) => ({ doc_id, basis, snippet: `${basis} 내용` });
  const g = groupByDoc([h('REG', '제12조제1항'), h('KH', '-'), h('REG', '제14조제1항'), h('REG', '제12조제1항')]);
  assert.deepEqual(g.map((x) => [x.doc_id, x.matches.map((m) => m.basis)]), [['REG', ['제12조제1항', '제14조제1항']], ['KH', ['-']]]);
});

test('인용 조문은 규정 이름과 묶는다: 규정 문서는 자기 이름, 노하우는 본문에서 조문 바로 앞 이름', async () => {
  const { clauseGroups } = await import('../src/library.ts');
  assert.deepEqual(clauseGroups(['제1조', '제7조의2'], '제1조(목적) …', '하나은행 기업여신 심사규정'), [{ law: '하나은행 기업여신 심사규정', clauses: ['제1조', '제7조의2'] }]);
  const text = '감정평가서는 기업여신 심사규정 제10조제2항에 따른다. 「개인정보 보호법」 제15조제1항: 수집. 그리고 제3조도 본다.';
  assert.deepEqual(clauseGroups(['제10조제2항', '제15조제1항', '제3조'], text, undefined, ['하나은행 기업여신 심사규정']), [
    { law: '하나은행 기업여신 심사규정', clauses: ['제10조제2항'] }, { law: '개인정보 보호법', clauses: ['제15조제1항'] }, { law: null, clauses: ['제3조'] },
  ]);
});
