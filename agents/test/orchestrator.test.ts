import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestGraph, publishGraph, run, type PipelineDeps, type StepOutput } from '../src/pipeline/orchestrator.ts';

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
  assert.deepEqual(order.slice(0, 2), ['malware_check', 'file_structure_check']);
  assert.deepEqual(new Set(order.slice(2, 4)), new Set(['text_layer_extract', 'page_render']));
  assert.deepEqual(order.slice(4), ['ocr_if_needed', 'segment_build', 'pii_scan', 'injection_scan', 'classify', 'trust_gate', 'await_review']);
  assert.ok(t.calls.every((c) => c.args.workflow_id === 'wf_1' && c.args.doc_id === 'doc_1'));
  assert.ok(t.records.includes('WaitForApproval=OK'));
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
