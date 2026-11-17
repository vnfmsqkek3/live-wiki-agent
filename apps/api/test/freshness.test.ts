// 살아있는 위키: 근거 규정 개정판이 시행되면 게시 노하우를 재검토 대상으로
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staleKnowhow } from '../src/steps/freshness.ts';
import { makeFinalize, makeFreshnessSweep } from '../src/lambdas.ts';
import { memoryStore } from '../src/store.ts';
import type { DocumentRecord } from '../src/contracts.ts';

const doc = (o: Partial<DocumentRecord> & { doc_id: string }): DocumentRecord => ({
  version: 1, owner: 'u', title: o.doc_id, dept: 'loan', acl_groups: ['ALL'], ext: 'pdf', lifecycle: 'PUBLISHED',
  authority_status: 'VERIFIED', freshness: 'CURRENT', findings: [], created_at: '', updated_at: '', ...o,
});
const reg = (rev: string, from: string, to = '9999-12-31', lifecycle: DocumentRecord['lifecycle'] = 'PUBLISHED') =>
  doc({ doc_id: `REG_${rev}`, document_type: 'REGULATION', law_id: 'SYN-LOAN-001', law_name: '기업여신 심사규정', revision_id: rev, effective_from: from, effective_to: to, lifecycle });
const kh = (id: string, pid: string, relation: 'SUPPORTS' | 'CONFLICTS' | 'INSUFFICIENT' = 'SUPPORTS', verified_quote = true) => doc({
  doc_id: id, document_type: 'KNOWHOW',
  knowhow_validation: { verdict: 'SUPPORTED', model: 'm', checked_at: '', outdated: [], items: [{ statement: 's', provision_id: pid, label: 'l', relation, reason: 'r', quote: 'q', verified_quote }] },
});

test('개정판이 시행 중이면 옛 판 인용 노하우만 재검토 (현행 인용·근거 아님·대조 실패는 제외)', () => {
  const docs = [reg('2026-11-01', '2026-11-01', '2026-11-30'), reg('2026-12-01', '2026-12-01'),
    kh('OLD', 'SYN-LOAN-001@2026-11-01/ARTICLE:12'), kh('NEW', 'SYN-LOAN-001@2026-12-01/ARTICLE:12'),
    kh('NOBASIS', 'SYN-LOAN-001@2026-11-01/ARTICLE:9', 'INSUFFICIENT'), kh('UNVERIFIED', 'SYN-LOAN-001@2026-11-01/ARTICLE:9', 'CONFLICTS', false)];
  const out = staleKnowhow(docs, '2026-12-02');
  assert.deepEqual(out.map((d) => d.doc_id), ['OLD']);
  assert.equal(out[0]!.freshness, 'REVIEW_REQUIRED');
  assert.deepEqual([out[0]!.freshness_reason?.cited_revision, out[0]!.freshness_reason?.current_revision], ['2026-11-01', '2026-12-01']);
});

test('최상위 document_type 없이 분류 결과만 있는 규정도 현행 판으로 인정', () => {
  const r = { ...reg('2026-11-01', '2026-11-01'), document_type: undefined, classification: { document_type: 'REGULATION' as const, business_path: [], tags: [], confidence: 1, rationale: '' } };
  assert.equal(staleKnowhow([r, kh('OLD', 'SYN-LOAN-001@2025-01-01/ARTICLE:12')], '2026-11-16').length, 1);
});

test('개정판이 시행 전이면 아직 표시하지 않음, 시행일이 되면 표시 (일 1회 점검)', () => {
  const docs = [reg('2026-11-01', '2026-11-01', '2026-11-30'), reg('2026-12-01', '2026-12-01'), kh('OLD', 'SYN-LOAN-001@2026-11-01/ARTICLE:12')];
  assert.equal(staleKnowhow(docs, '2026-11-16').length, 0);
  assert.equal(staleKnowhow(docs, '2026-12-01').length, 1);
});

test('이미 재검토 중이거나 게시 전 문서·반려된 개정판은 대상 아님 (멱등)', () => {
  const docs = [reg('2026-12-01', '2026-12-01', '9999-12-31', 'BLOCKED'), reg('2026-11-01', '2026-11-01'),
    { ...kh('A', 'SYN-LOAN-001@2025-01-01/ARTICLE:12'), freshness: 'REVIEW_REQUIRED' as const }, { ...kh('B', 'SYN-LOAN-001@2025-01-01/ARTICLE:12'), lifecycle: 'IN_REVIEW' as const }];
  assert.equal(staleKnowhow(docs, '2026-12-02').length, 0);
});

test('Finalize(규정 게시)·freshnessSweep가 노하우를 저장하고 감사 기록', async () => {
  const store = memoryStore();
  const deps = { store, headObject: async () => undefined, getObjectBytes: async () => new Uint8Array(), startWorkflow: async () => {} };
  await store.putDoc(reg('2025-01-01', '2025-01-01', '2026-10-31'));
  await store.putDoc(kh('OLD', 'SYN-LOAN-001@2025-01-01/ARTICLE:12'));
  await store.putDoc({ ...reg('2026-11-01', '2026-11-01'), lifecycle: 'IN_REVIEW' });
  await makeFinalize(deps)({ workflow_id: 'wf', doc_id: 'REG_2026-11-01', version: 1, bucket: 'b', prefix: 'p', actor: { sub: 'u', groups: [] }, outcome: 'PUBLISHED' });
  assert.equal((await store.getDoc('OLD'))!.freshness, 'REVIEW_REQUIRED');
  assert.ok(store.audits.some((a) => a.action === 'FRESHNESS_REVIEW_REQUIRED' && a.resource === 'OLD'));
  assert.deepEqual(await makeFreshnessSweep(deps)(), { marked: 0, purged: 0 }); // 멱등
});

test('Finalize(게시): 사람 승인을 거친 노하우·매뉴얼은 검증 완료, 규정은 Registry 결과 유지', async () => {
  const store = memoryStore();
  const deps = { store, headObject: async () => undefined, getObjectBytes: async () => new Uint8Array(), startWorkflow: async () => {} };
  const inp = (doc_id: string) => ({ workflow_id: 'wf', doc_id, version: 1, bucket: 'b', prefix: 'p', actor: { sub: 'u', groups: [] }, outcome: 'PUBLISHED' as const });
  await store.putDoc({ ...kh('M', 'SYN-LOAN-001@2026-11-01/ARTICLE:1'), document_type: 'MANUAL', lifecycle: 'PENDING_APPROVAL', authority_status: 'UNVERIFIED' });
  await store.putDoc({ ...reg('2026-11-01', '2026-11-01'), lifecycle: 'PENDING_APPROVAL', authority_status: 'UNVERIFIED' });
  await makeFinalize(deps)(inp('M'));
  await makeFinalize(deps)(inp('REG_2026-11-01'));
  assert.equal((await store.getDoc('M'))!.authority_status, 'VERIFIED');
  assert.equal((await store.getDoc('REG_2026-11-01'))!.authority_status, 'UNVERIFIED');
});

test('차단·반려: 원본·work는 바로 삭제, masked는 7일 뒤 sweep이 삭제, 게시 문서는 건드리지 않음', async () => {
  const { purgeExpiredMasked } = await import('../src/lambdas.ts');
  const store = memoryStore();
  const purged: string[] = [];
  const deps = { store, headObject: async () => undefined, getObjectBytes: async () => new Uint8Array(), startWorkflow: async () => {}, purge: async (p: string) => { purged.push(p); return 2; } };
  const inp = (doc_id: string, outcome: 'BLOCKED' | 'REJECTED' | 'PUBLISHED') => ({ workflow_id: 'wf', doc_id, version: 1, bucket: 'b', prefix: 'p', actor: { sub: 'u', groups: [] }, outcome });
  await store.putDoc({ ...kh('B', 'x@1/A'), lifecycle: 'QUARANTINED' });
  await store.putDoc({ ...kh('P', 'x@1/A'), lifecycle: 'PENDING_APPROVAL' });
  await makeFinalize(deps)(inp('B', 'BLOCKED'));
  await makeFinalize(deps)(inp('P', 'PUBLISHED'));
  assert.deepEqual(purged, ['B/original.', 'B/work/']);
  const b = (await store.getDoc('B'))!;
  assert.ok(b.purge?.original_at && b.purge.objects === 4);
  assert.ok(store.audits.some((a) => a.action === 'PURGE_ORIGINAL' && a.resource === 'B'));
  assert.equal(await purgeExpiredMasked(deps), 0); // 7일 전
  assert.equal(await purgeExpiredMasked(deps, new Date(Date.now() + 8 * 86_400_000)), 1);
  assert.equal(purged.at(-1), 'B/');
  assert.equal(await purgeExpiredMasked(deps, new Date(Date.now() + 9 * 86_400_000)), 0); // 멱등
});
