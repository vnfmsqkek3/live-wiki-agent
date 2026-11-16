// 문서 처리 오케스트레이터 (AgentCore Runtime에서 실행, 사용자 결정 11/16: Step Functions 대체).
// Strands Graph로 단계 순서를 고정한다 (LLM이 순서를 정하지 않음 → 같은 입력이면 같은 경로, docs/02 반복 가능).
// 각 단계는 AgentCore Gateway Tool(= 기존 단계 Lambda)로 호출한다. 상태는 DynamoDB에만 둔다 (세션은 상태 저장소 아님).
import { Graph, Node, type MultiAgentState, type NodeResultUpdate } from '@strands-agents/sdk/multiagent';

export interface StepInput { workflow_id: string; doc_id: string; version: number; bucket: string; prefix: string; actor: { sub: string; groups: string[] } }
export interface StepOutput { status: 'OK' | 'REVIEW_REQUIRED' | 'BLOCKED' | 'PENDING'; output_key?: string; findings?: unknown[] }

export interface PipelineDeps {
  /** Gateway Tool 호출 (단계 키 = Tool 이름). 단계 예외는 throw */
  callTool(step: string, args: Record<string, unknown>): Promise<StepOutput>;
  /** WORKFLOWS `WF#{id}/STEP#{name}` 기록 (기존 SFN 스키마 유지) */
  /** message: Tool이 준 사용자 안내 문장 (한국어 문장만 화면 표시, API가 거른다) */
  record(workflow_id: string, doc_id: string, step: string, status: string, error?: string, message?: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  pollMs?: number;
  maxPolls?: number;
  /** 그림 분석 단계(13항, yoyo0704 Lambda). Gateway Target 등록 전에는 끈다 (env IMAGE_DESCRIBE=on) */
  imageDescribe?: boolean;
}

/** 단계 키 → 기록 이름 (기존 ASL과 동일) */
export const STEP_NAMES: Record<string, string> = {
  malware_check: 'MalwareCheck', file_structure_check: 'FileStructureCheck', text_layer_extract: 'TextLayerExtract', page_render: 'PageRender',
  ocr_if_needed: 'OcrIfNeeded', segment_build: 'SegmentBuild', pii_scan: 'PiiScan', image_describe: 'ImageDescribe', injection_scan: 'InjectionScan', classify: 'Classify',
  trust_gate: 'TrustGate', explain_findings: 'ExplainFindings', await_review: 'WaitForApproval', promote: 'Promote', kb_ingest: 'KbIngest', graph_upsert: 'GraphUpsert', finalize: 'Finalize',
};

const BLOCKED = 'blocked';
const REVIEW = 'review'; // 어느 단계든 REVIEW_REQUIRED였으면 true

/** 단계 노드: 앞에서 BLOCKED면 아무 것도 하지 않고 통과. PENDING이면 대기 후 같은 입력으로 재호출 (단계는 멱등) */
class StepNode extends Node {
  readonly step: string;
  readonly deps: PipelineDeps;
  readonly input: StepInput;
  readonly extra: (state: MultiAgentState) => Record<string, unknown>;
  constructor(step: string, deps: PipelineDeps, input: StepInput, extra: (state: MultiAgentState) => Record<string, unknown> = () => ({})) {
    super(step, { description: STEP_NAMES[step] ?? step });
    this.step = step; this.deps = deps; this.input = input; this.extra = extra;
  }
  // eslint-disable-next-line require-yield -- Strands Node 계약이 AsyncGenerator. 스트림 이벤트 없이 결과만 반환
  async *handle(_i: unknown, state: MultiAgentState): AsyncGenerator<never, NodeResultUpdate, undefined> {
    const name = STEP_NAMES[this.step] ?? this.step;
    const skip = state.app.get(BLOCKED) === true && this.step !== 'finalize';
    if (skip) return done(`${name}: skipped (blocked)`);
    let out: StepOutput | undefined;
    try {
      for (let n = 0; ; n++) {
        out = await this.deps.callTool(this.step, { ...this.input, ...this.extra(state) });
        if (out.status !== 'PENDING') break;
        if (n + 1 >= (this.deps.maxPolls ?? 80)) throw new Error(`${name} polling timeout`);
        await this.deps.sleep(this.deps.pollMs ?? 15_000);
      }
    } catch (e) {
      const err = e as Error;
      await this.deps.record(this.input.workflow_id, this.input.doc_id, name, 'FAILED', err.name === 'Error' ? 'StepFailed' : err.name, err.message?.slice(0, 300));
      throw e; // Graph 실패 → 실행 FAILED 기록은 호출자
    }
    await this.deps.record(this.input.workflow_id, this.input.doc_id, name, out!.status);
    if (out!.status === 'BLOCKED') state.app.set(BLOCKED, true);
    if (out!.status === 'REVIEW_REQUIRED') state.app.set(REVIEW, true);
    return done(`${name}: ${out!.status}`);
  }
}
const done = (text: string): NodeResultUpdate => ({ status: 'COMPLETED', content: [{ type: 'textBlock', text } as never] });

const chain = (ids: string[]) => ids.slice(1).map((t, i) => [ids[i]!, t] as [string, string]);

/** 1차 실행: 업로드 → 자동 검사 → 작성자 검토 대기 (BLOCKED면 finalize BLOCKED) */
export function ingestGraph(deps: PipelineDeps, input: StepInput) {
  const n = (s: string, extra?: (st: MultiAgentState) => Record<string, unknown>) => new StepNode(s, deps, input, extra);
  // 차단이 아니면 검토 대기(await_review), 차단이면 finalize(BLOCKED). 둘 다 마지막에 두고 노드 안에서 분기
  const tail = new ReviewOrBlock(deps, input);
  return new Graph({
    nodes: [
      n('malware_check'), n('file_structure_check'), n('text_layer_extract'), n('page_render'), n('ocr_if_needed'), n('segment_build'),
      n('pii_scan'), ...(deps.imageDescribe ? [n('image_describe')] : []), n('injection_scan'), n('classify'), n('trust_gate'), tail,
    ],
    edges: [
      ['malware_check', 'file_structure_check'],
      ['file_structure_check', 'text_layer_extract'], ['file_structure_check', 'page_render'], // 병렬
      ['text_layer_extract', 'ocr_if_needed'], ['page_render', 'ocr_if_needed'], // 합류 (둘 다 끝나야 실행)
      // 그림 묘사 텍스트도 지시문 검사를 받도록 InjectionScan 앞 (yoyo0704 합의)
      ...chain(['ocr_if_needed', 'segment_build', 'pii_scan', ...(deps.imageDescribe ? ['image_describe'] : []), 'injection_scan', 'classify', 'trust_gate', 'review_or_block']),
    ],
    sources: ['malware_check'],
    maxSteps: 30,
  });
}

/** 마지막 노드: 차단이면 finalize(BLOCKED), 아니면 await_review(문서 IN_REVIEW, 실행 종료 — 승인은 resume으로) */
class ReviewOrBlock extends Node {
  readonly deps: PipelineDeps;
  readonly input: StepInput;
  constructor(deps: PipelineDeps, input: StepInput) { super('review_or_block', { description: '검토 대기 또는 차단 종료' }); this.deps = deps; this.input = input; }
  // eslint-disable-next-line require-yield -- Strands Node 계약이 AsyncGenerator. 스트림 이벤트 없이 결과만 반환
  async *handle(_i: unknown, state: MultiAgentState): AsyncGenerator<never, NodeResultUpdate, undefined> {
    const blocked = state.app.get(BLOCKED) === true;
    // 차단·검토 필요면 확인 결과를 사람이 읽을 설명으로 (yoyo0704 explain_findings, 사용자 지시 11/17). 부가 기능이라 실패해도 계속
    if (blocked || state.app.get(REVIEW) === true) {
      try {
        const ex = await this.deps.callTool('explain_findings', { ...this.input });
        await this.deps.record(this.input.workflow_id, this.input.doc_id, STEP_NAMES.explain_findings!, ex.status);
      } catch (e) {
        await this.deps.record(this.input.workflow_id, this.input.doc_id, STEP_NAMES.explain_findings!, 'SKIPPED', (e as Error).name).catch(() => {});
      }
    }
    const step = blocked ? 'finalize' : 'await_review';
    const out = await this.deps.callTool(step, { ...this.input, ...(blocked ? { outcome: 'BLOCKED' } : {}) });
    await this.deps.record(this.input.workflow_id, this.input.doc_id, STEP_NAMES[step]!, blocked ? 'BLOCKED' : out.status);
    return done(blocked ? 'BLOCKED' : 'AWAITING_REVIEW');
  }
}

/** 2차 실행 (승인 API가 호출): APPROVE면 게시 단계, 아니면 finalize(REJECTED) */
export function publishGraph(deps: PipelineDeps, input: StepInput, decision: 'APPROVE' | 'REJECT' | 'REVALIDATE') {
  const n = (s: string, extra?: (st: MultiAgentState) => Record<string, unknown>) => new StepNode(s, deps, input, extra);
  if (decision !== 'APPROVE')
    return new Graph({ nodes: [n('finalize', () => ({ outcome: 'REJECTED' }))], edges: [], sources: ['finalize'], maxSteps: 3 });
  return new Graph({
    nodes: [n('promote'), n('kb_ingest'), n('graph_upsert'), n('finalize', (st) => ({ outcome: st.app.get(BLOCKED) === true ? 'BLOCKED' : 'PUBLISHED' }))],
    edges: chain(['promote', 'kb_ingest', 'graph_upsert', 'finalize']),
    sources: ['promote'],
    maxSteps: 10,
  });
}

/** 실행 + 실패 기록. 반환: 마지막 상태 요약 */
export async function run(graph: Graph, deps: PipelineDeps, input: StepInput) {
  try {
    const r = await graph.invoke(`workflow ${input.workflow_id}`);
    if (r.status !== 'COMPLETED') throw r.error ?? new Error(`graph ${r.status}`);
    await deps.record(input.workflow_id, input.doc_id, 'EXECUTION', 'SUCCEEDED'); // 이전 실행의 FAILED 기록을 덮어쓴다
    return { status: 'COMPLETED' as const, steps: r.results.map((x) => x.nodeId) };
  } catch (e) {
    // 기록 자체가 실패해도 프로세스를 죽이지 않는다 (Runtime 세션 보호)
    await deps.record(input.workflow_id, input.doc_id, 'EXECUTION', 'FAILED', 'IngestStepFailed').catch((x: Error) => console.error(JSON.stringify({ record_failed: x.name })));
    return { status: 'FAILED' as const, error: (e as Error).message.slice(0, 200) };
  }
}
