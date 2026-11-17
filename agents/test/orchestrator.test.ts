import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteGraph, ingestGraph, publishGraph, run, type PipelineDeps, type StepOutput } from '../src/pipeline/orchestrator.ts';

const input = { workflow_id: 'wf_1', doc_id: 'doc_1', version: 1, bucket: 'b', prefix: 'doc_1/', actor: { sub: 'u', groups: ['AUTHOR'] } };

function deps(over: Record<string, (n: number) => StepOutput | Error> = {}) {
  const calls: { step: string; args: Record<string, unknown> }[] = [];
  const records: string[] = [];
  const count: Record<string, number> = {};
  const d: PipelineDeps = {
    callTool: async (step, args) => {
      calls.push({ step, args });
      count[step] = (count[step] ?? 0) + 1;
      const r = over[step]?.(count[step]!) ?? { status: 'OK' };
      if (r instanceof Error) throw r;
      return r;
    },
    record: async (_w, _d, step, status) => { records.push(`${step}=${status}`); },
    sleep: async () => {},
    pollMs: 0,
  };
  return { d, calls, records };
}

test('1차: 고정 순서 (병렬 2개 합류 후 진행), 마지막에 검토 대기', async () => {
  const t = deps();
  const r = await run(ingestGraph(t.d, input), t.d, input);
  assert.equal(r.status, 'COMPLETED');
  const order = t.calls.map((c) => c.step);
  assert.deepEqual(order.slice(0, 3), ['malware_check', 'file_structure_check', 'convert_to_pdf']);
  assert.deepEqual(new Set(order.slice(3, 5)), new Set(['text_layer_extract', 'page_render']));
  assert.deepEqual(order.slice(5), ['ocr_if_needed', 'segment_build', 'pii_scan', 'injection_scan', 'classify', 'trust_gate', 'await_review']);
  assert.ok(t.calls.every((c) => c.args.workflow_id === 'wf_1' && c.args.doc_id === 'doc_1'));
  assert.ok(t.records.includes('WaitForApproval=OK'));
  assert.equal(t.records.at(-1), 'EXECUTION=SUCCEEDED');
});

test('선택 단계: IMAGE_DESCRIBE·PAGE_SUMMARIZE 켜면 pii_scan → image_describe → injection_scan → page_summarize → classify', async () => {
  const t = deps();
  const d = { ...t.d, imageDescribe: true, pageSummarize: true };
  await run(ingestGraph(d, input), d, input);
  const order = t.calls.map((c) => c.step);
  assert.deepEqual(order.slice(7, 12), ['pii_scan', 'image_describe', 'injection_scan', 'page_summarize', 'classify']);
  assert.ok(t.records.includes('PageSummarize=OK'));
});

test('PENDING은 같은 입력으로 재호출 (멱등 폴링)', async () => {
  const t = deps({ malware_check: (n) => ({ status: n < 3 ? 'PENDING' : 'OK' }) });
  await run(ingestGraph(t.d, input), t.d, input);
  assert.equal(t.calls.filter((c) => c.step === 'malware_check').length, 3);
});

test('BLOCKED면 이후 단계는 호출하지 않고 finalize(BLOCKED)로 끝남, 검토 대기 안 함', async () => {
  const t = deps({ injection_scan: () => ({ status: 'BLOCKED' }) });
  const r = await run(ingestGraph(t.d, input), t.d, input);
  assert.equal(r.status, 'COMPLETED');
  const order = t.calls.map((c) => c.step);
  assert.ok(!order.includes('classify') && !order.includes('trust_gate') && !order.includes('await_review'));
  assert.deepEqual(t.calls.at(-1), { step: 'finalize', args: { ...input, outcome: 'BLOCKED' } });
});

test('단계 예외 → 단계 FAILED + EXECUTION FAILED 기록, 이후 단계 없음', async () => {
  const t = deps({ text_layer_extract: () => Object.assign(new Error('bad pdf'), { name: 'InvalidPDFException' }) });
  const r = await run(ingestGraph(t.d, input), t.d, input);
  assert.equal(r.status, 'FAILED');
  assert.ok(t.records.includes('TextLayerExtract=FAILED'));
  assert.ok(t.records.includes('EXECUTION=FAILED'));
  assert.ok(!t.calls.some((c) => c.step === 'segment_build'));
});

test('2차: APPROVE면 promote→kb_ingest(폴링)→graph_upsert→finalize(PUBLISHED), 거절이면 finalize(REJECTED)만', async () => {
  const t = deps({ kb_ingest: (n) => ({ status: n < 2 ? 'PENDING' : 'OK' }) });
  await run(publishGraph(t.d, input, 'APPROVE'), t.d, input);
  assert.deepEqual(t.calls.map((c) => c.step), ['promote', 'kb_ingest', 'kb_ingest', 'graph_upsert', 'finalize']);
  assert.equal(t.calls.at(-1)!.args.outcome, 'PUBLISHED');

  const u = deps();
  await run(publishGraph(u.d, input, 'REJECT'), u.d, input);
  assert.deepEqual(u.calls, [{ step: 'finalize', args: { ...input, outcome: 'REJECTED' } }]);
});

test('차단·검토 필요면 끝내기 전에 explain_findings 호출, 설명 실패는 SKIPPED로 두고 계속 / 문제없으면 호출 안 함', async () => {
  const b = deps({ file_structure_check: () => ({ status: 'BLOCKED' }) });
  await run(ingestGraph(b.d, input), b.d, input);
  assert.deepEqual(b.calls.slice(-2).map((c) => c.step), ['explain_findings', 'finalize']);
  const r = deps({ trust_gate: () => ({ status: 'REVIEW_REQUIRED' }), explain_findings: () => Object.assign(new Error('x'), { name: 'ModelError' }) });
  assert.equal((await run(ingestGraph(r.d, input), r.d, input)).status, 'COMPLETED');
  assert.ok(r.records.includes('ExplainFindings=SKIPPED'));
  assert.equal(r.calls.at(-1)!.step, 'await_review');
  const ok = deps();
  await run(ingestGraph(ok.d, input), ok.d, input);
  assert.ok(!ok.calls.some((c) => c.step === 'explain_findings'));
});

test('삭제: purge_document → kb_ingest·graph_upsert(action=delete) → finalize(DELETED, graph_upsert의 affected_doc_ids)', async () => {
  const t = deps({ graph_upsert: () => ({ status: 'OK', affected_doc_ids: ['doc_K1'] }) });
  const r = await run(deleteGraph(t.d, input), t.d, input);
  assert.equal(r.status, 'COMPLETED');
  assert.deepEqual(t.calls.map((c) => c.step), ['purge_document', 'kb_ingest', 'graph_upsert', 'finalize']);
  assert.equal(t.calls[1]!.args.action, 'delete');
  assert.equal(t.calls[2]!.args.action, 'delete');
  assert.deepEqual([t.calls[3]!.args.outcome, t.calls[3]!.args.affected_doc_ids], ['DELETED', ['doc_K1']]);
  assert.ok(t.records.includes('PurgeDocument=OK'));
});

test('문서 변환 실패(BLOCKED)면 뒤 단계는 건너뛰고 차단으로 끝난다', async () => {
  const t = deps({ convert_to_pdf: () => ({ status: 'BLOCKED' }) });
  await run(ingestGraph(t.d, input), t.d, input);
  const order = t.calls.map((c) => c.step);
  assert.ok(!order.includes('text_layer_extract') && !order.includes('ocr_if_needed'), order.join(','));
  assert.ok(t.records.includes('ConvertToPdf=BLOCKED'));
});

test('위키 수정본(text_only): 변환·쪽 이미지·OCR 없이 글자 추출 → 본문 정리 → 검사', async () => {
  const t = deps();
  await run(ingestGraph(t.d, input, { textOnly: true }), t.d, input);
  const order = t.calls.map((c) => c.step);
  assert.deepEqual(order.slice(0, 4), ['malware_check', 'file_structure_check', 'text_layer_extract', 'segment_build']);
  assert.ok(!order.includes('convert_to_pdf') && !order.includes('page_render') && !order.includes('ocr_if_needed'));
  assert.equal(order.at(-1), 'await_review');
});

test('참조 확인(REFERENCE_CHECK=on): classify 뒤 reference_check, 그 뒤 trust_gate', async () => {
  const t = deps();
  const d = { ...t.d, referenceCheck: true };
  await run(ingestGraph(d, input), d, input);
  const order = t.calls.map((c) => c.step);
  assert.equal(order[order.indexOf('classify') + 1], 'reference_check');
  assert.equal(order[order.indexOf('reference_check') + 1], 'trust_gate');
});
