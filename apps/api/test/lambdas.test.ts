import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.ts';
import { newId, type DocumentRecord } from '../src/contracts.ts';
import { makeFileStructureCheck, makeFinalize, makeTrustGate, makeTypeDetection, makeWaitForApproval, type LambdaDeps } from '../src/lambdas.ts';

function setup(bytes: Uint8Array) {
  const store = memoryStore();
  const started: string[] = [];
  const deps: LambdaDeps = {
    store,
    headObject: async () => ({ s3_version_id: 'v1', content_hash: 'h1' }),
    getObjectBytes: async (_k, _v, range) => (range ? bytes.subarray(0, range) : bytes),
    startWorkflow: async (d) => { started.push(d.workflow_id!); },
  };
  const doc: DocumentRecord = {
    doc_id: newId.doc(), version: 1, owner: 'u-author', title: '[SYNTHETIC] t', dept: 'loan', acl_groups: ['ALL'], ext: 'pdf', workflow_id: newId.wf(),
    lifecycle: 'QUARANTINED', authority_status: 'UNVERIFIED', freshness: 'CURRENT', findings: [], created_at: '', updated_at: '',
  };
  const input = { workflow_id: doc.workflow_id!, doc_id: doc.doc_id, version: 1, bucket: 'b', prefix: `${doc.doc_id}/`, actor: { sub: 'u-author', groups: ['AUTHOR'] } };
  const sqs = (k: string) => ({ Records: [{ body: JSON.stringify({ detail: { object: { key: k } } }) }] });
  return { store, deps, doc, input, started, sqs };
}

const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n');

test('type-detection: 정상 PDF는 버전·해시 기록 후 워크플로 시작, 위장 파일은 BLOCKED로 시작 안 함', async () => {
  const t = setup(pdf);
  await t.store.putDoc(t.doc);
  await makeTypeDetection(t.deps)(t.sqs(`${t.doc.doc_id}/original.pdf`));
  assert.deepEqual(t.started, [t.doc.workflow_id]);
  assert.equal((await t.store.getDoc(t.doc.doc_id))!.s3_version_id, 'v1');

  const b = setup(new Uint8Array([0x4d, 0x5a, 0, 0]));
  await b.store.putDoc(b.doc);
  await makeTypeDetection(b.deps)(b.sqs(`${b.doc.doc_id}/original.pdf`));
  assert.equal(b.started.length, 0);
  assert.equal((await b.store.getDoc(b.doc.doc_id))!.lifecycle, 'BLOCKED');
});

test('type-detection: 형식 밖 키·모르는 문서는 무시', async () => {
  const t = setup(pdf);
  await makeTypeDetection(t.deps)(t.sqs('etc/x.pdf'));
  await makeTypeDetection(t.deps)(t.sqs(`${newId.doc()}/original.pdf`));
  assert.equal(t.started.length, 0);
});

test('단계 체인: FileStructure OK → TrustGate(분류 없음) REVIEW_REQUIRED → WaitForApproval 토큰 저장 → Finalize PUBLISHED', async () => {
  const t = setup(pdf);
  await t.store.putDoc(t.doc);
  assert.equal((await makeFileStructureCheck(t.deps)(t.input)).status, 'OK');
  assert.equal((await makeTrustGate(t.deps)(t.input)).status, 'REVIEW_REQUIRED');
  await makeWaitForApproval(t.deps)({ ...t.input, task_token: 'tok' });
  let d = (await t.store.getDoc(t.doc.doc_id))!;
  assert.deepEqual([d.lifecycle, d.task_token, d.trust_gate_result], ['IN_REVIEW', 'tok', 'REVIEW_REQUIRED']);
  await makeFinalize(t.deps)({ ...t.input, outcome: 'PUBLISHED' });
  d = (await t.store.getDoc(t.doc.doc_id))!;
  assert.deepEqual([d.lifecycle, d.task_token], ['PUBLISHED', undefined]);
  assert.equal(t.store.audits.at(-1)!.action, 'FINALIZE_PUBLISHED');
});

test('FileStructure: 스크립트 PDF는 BLOCKED, TrustGate는 QUARANTINED→BLOCKED, Finalize BLOCKED', async () => {
  const t = setup(new TextEncoder().encode('%PDF-1.7 /OpenAction << /S /JavaScript /JS (x) >>'));
  await t.store.putDoc(t.doc);
  assert.equal((await makeFileStructureCheck(t.deps)(t.input)).status, 'BLOCKED');
  assert.equal((await makeTrustGate(t.deps)(t.input)).status, 'BLOCKED');
  await makeFinalize(t.deps)({ ...t.input, outcome: 'BLOCKED' });
  assert.equal((await t.store.getDoc(t.doc.doc_id))!.lifecycle, 'BLOCKED');
});

test('문서가 없으면 예외 (빈 성공 금지)', async () => {
  const t = setup(pdf);
  await assert.rejects(makeTrustGate(t.deps)(t.input), /document not found/);
});
