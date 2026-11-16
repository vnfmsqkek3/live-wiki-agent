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
};
const base = (o: Partial<DocumentRecord> & { doc_id: string }): DocumentRecord => ({
  version: 1, owner: 'u-other', title: o.doc_id, dept: 'loan', acl_groups: ['ALL'], ext: 'pdf', lifecycle: 'PUBLISHED',
  authority_status: 'VERIFIED', freshness: 'CURRENT', findings: [], created_at: '2026-11-16', updated_at: '2026-11-16', ...o,
});
const item = (provision_id: string, relation: 'SUPPORTS' | 'CONFLICTS' | 'INSUFFICIENT', verified_quote = true) =>
  ({ statement: 's', provision_id, label: `라벨 ${provision_id}`, relation, reason: 'r', quote: 'q', verified_quote });

async function setup() {
  const store = memoryStore();
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
  const deps = {
    verify: async (t: string) => { const u = USERS[t]; if (!u) throw new ApiError('UNAUTHORIZED', 'x'); return u; },
    store, presignPut: async () => '', headObject: async () => undefined, startWorkflow: async () => {}, resume: async () => true,
    search: async () => [], guide: async () => ({}),
    pages: async () => [{ page: 1, text: '둘째 장' }, { page: 0, text: '1억원 이하는 현장 실사를 생략한다.' }],
    marks: async () => [{ page: 0, start: 0, end: 5, severity: 'HIGH', kind: 'CONFLICT', reason: '실사 의무' }, { page: null, start: null, end: null, severity: 'HIGH', kind: 'REGISTRY_MISMATCH', reason: '조문 누락' }],
  } as Deps;
  const app = createApp(deps);
  const get = (who: string, path: string) => app.request(path, { headers: { authorization: `Bearer ${who}` } });
  return { get };
}

test('목록: 권한 내 게시 문서 + 본인 문서만, 타인 미게시·권한 밖 제외', async () => {
  const t = await setup();
  const ids = ((await (await t.get('author', '/v1/library')).json()) as { items: { doc_id: string }[] }).items.map((i) => i.doc_id).sort();
  assert.deepEqual(ids, ['DRAFT', 'KH', 'REG', 'REG_NEXT']);
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
  assert.equal(d.pages[1]!.summary, null);
  assert.equal(d.pages[1]!.marks.length, 0);
  assert.deepEqual(d.doc_marks.map((m) => m.kind), ['REGISTRY_MISMATCH']);
  assert.equal((await t.get('user', '/v1/library/SECRET')).status, 404);
  assert.equal((await t.get('user', '/v1/library/OTHERS_DRAFT')).status, 404);
});

test('상세 검증 정보: 문서 표기 일자, 노하우 비교 조문·승인자·시각, 매뉴얼은 사람 승인 방식', async () => {
  const { docDate, verification } = await import('../src/library.ts');
  assert.deepEqual(docDate([{ page: 0, text: '문서 관리번호 05\n개정일 / 버전 2026.10.15 / 1.0' }]), { label: '개정일', date: '2026-10-15' });
  const base = { doc_id: 'X', version: 1, owner: 'o', title: 't', dept: 'd', acl_groups: ['ALL'], ext: 'pdf', lifecycle: 'PUBLISHED' as const, authority_status: 'VERIFIED' as const, freshness: 'CURRENT' as const, findings: [], created_at: '', updated_at: '' };
  const v = verification({ ...base, document_type: 'KNOWHOW', knowhow_validation: { verdict: 'SUPPORTED', model: 'm', checked_at: 'c', outdated: [], items: [{ statement: 's', provision_id: 'p', label: '기업여신 심사규정 제10조제2항', relation: 'SUPPORTS', reason: 'r', quote: '6개월 이내', verified_quote: true }] } },
    { approver_sub: 'abcdefgh123', approver_name: 'admin', decided_at: '2026-11-17T01:00:00Z', reason: '확인' });
  assert.equal(v.approved_by, 'admin');
  assert.equal(v.basis[0]!.label, '기업여신 심사규정 제10조제2항');
  assert.equal(v.basis[0]!.result, '규정과 일치');
  assert.match(verification({ ...base, document_type: 'MANUAL' }).method, /사람 승인/);
  assert.equal(verification({ ...base, document_type: 'MANUAL' }, { approver_sub: 'abcdefgh123' }).approved_by, '관리자 계정(abcdefgh)');
});
