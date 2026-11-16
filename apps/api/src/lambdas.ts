// 단계 Lambda (Owner dhxorb96, docs/05 3장). 입출력 계약: interfaces.md 6장.
// 진입점은 handlers.ts. 여기 함수들은 의존성을 주입받아 테스트한다.
import { createHash } from 'node:crypto';
import type { DocumentRecord, Finding, StepOutput } from './contracts.ts';
import type { Store } from './store.ts';
import { fileStructureCheck, typeDetection, type FileKind } from './steps/file-checks.ts';
import { trustGate } from './steps/trust-gate.ts';

export interface StepInput { workflow_id: string; doc_id: string; version: number; bucket: string; prefix: string; actor: { sub: string; groups: string[] } }

export interface LambdaDeps {
  store: Store;
  headObject(key: string): Promise<{ s3_version_id: string } | undefined>;
  getObjectBytes(key: string, versionId?: string, range?: number): Promise<Uint8Array>;
  startWorkflow(d: DocumentRecord): Promise<void>;
}

const key = (d: DocumentRecord) => `${d.doc_id}/original.${d.ext}`;
const now = () => new Date().toISOString();

async function mustDoc(store: Store, id: string) {
  const d = await store.getDoc(id);
  if (!d) throw new Error(`document not found: ${id}`); // 빈 결과로 성공 처리 금지 → SFN Catch
  return d;
}
const addFindings = (d: DocumentRecord, f: Finding[] = []) => ({ ...d, findings: [...d.findings.filter((x) => !f.some((y) => y.step === x.step)), ...f], updated_at: now() });

/** 업로드 이벤트(EventBridge → SQS) → 형식 판정 → 워크플로 시작. 차단이면 시작하지 않고 BLOCKED 기록 */
export function makeTypeDetection(deps: LambdaDeps) {
  return async (event: { Records: { body: string }[] }) => {
    for (const r of event.Records) {
      const ev = JSON.parse(r.body) as { detail?: { object?: { key?: string } } };
      const k = ev.detail?.object?.key ?? '';
      const m = /^(doc_[0-9A-HJKMNP-TV-Z]{26})\/original\.([a-z]+)$/.exec(k);
      if (!m) { console.warn(JSON.stringify({ msg: 'ignored key', key_prefix: k.slice(0, 40) })); continue; }
      const d = await deps.store.getDoc(m[1]!);
      if (!d) { console.warn(JSON.stringify({ msg: 'unknown doc', doc_id: m[1] })); continue; }
      if (d.lifecycle === 'BLOCKED') continue;
      const head = await deps.headObject(k);
      if (!head) throw new Error('object missing'); // SQS 재시도 → DLQ
      const t = typeDetection(m[2]!, await deps.getObjectBytes(k, head.s3_version_id, 8192));
      // 검사 대상 버전을 여기서 고정한다. 이후 단계는 모두 이 버전만 읽는다
      const next = addFindings({ ...d, s3_version_id: d.s3_version_id ?? head.s3_version_id }, t.findings);
      if (t.status === 'BLOCKED') { await deps.store.putDoc({ ...next, lifecycle: 'BLOCKED', trust_gate_result: 'QUARANTINED' }); continue; }
      await deps.store.putDoc(next);
      await deps.startWorkflow(next);
    }
  };
}

/** 단계 2 */
export function makeFileStructureCheck(deps: LambdaDeps) {
  return async (i: StepInput): Promise<StepOutput> => {
    const d = await mustDoc(deps.store, i.doc_id);
    const kind = (d.ext === 'jpeg' ? 'jpg' : d.ext) as FileKind;
    const bytes = await deps.getObjectBytes(key(d), d.s3_version_id);
    const out = fileStructureCheck(kind, bytes);
    // 승인 바인딩 해시 = 검사한 원본 바이트의 sha256 (Promote가 같은 방식으로 대조, let522mj 합의)
    const content_hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    await deps.store.putDoc({ ...addFindings(d, out.findings), content_hash });
    return { status: out.status, findings: out.findings };
  };
}

/** 단계 9. Registry 대조는 let522mj Registry 연동 전까지 미등록으로 처리 (REGULATION이면 REVIEW_REQUIRED) */
export function makeTrustGate(deps: LambdaDeps) {
  return async (i: StepInput): Promise<StepOutput> => {
    const d = await mustDoc(deps.store, i.doc_id);
    const g = trustGate({ doc: d }); // ponytail: claimed/registry 미연동 (11/19 let522mj Registry)
    await deps.store.putDoc({ ...addFindings(d, g.findings), trust_gate_result: g.result, authority_status: g.authority_status });
    return { status: g.result === 'PASS' ? 'OK' : g.result === 'QUARANTINED' ? 'BLOCKED' : 'REVIEW_REQUIRED', findings: g.findings };
  };
}

/** 단계 10 (.waitForTaskToken). 토큰을 문서에 저장하고 작성자 검토 단계로 둔다. 재개는 승인 API의 SendTaskSuccess */
export function makeWaitForApproval(deps: LambdaDeps) {
  return async (i: StepInput & { task_token: string }) => {
    const d = await mustDoc(deps.store, i.doc_id);
    await deps.store.putDoc({ ...d, task_token: i.task_token, lifecycle: 'IN_REVIEW', updated_at: now() });
    return { status: 'PENDING' };
  };
}

/** 단계 14. outcome에 따라 최종 상태. 승인 레코드 USED 전환은 Promote(let522mj)가 한다 */
export function makeFinalize(deps: LambdaDeps) {
  return async (i: StepInput & { outcome: 'PUBLISHED' | 'BLOCKED' | 'REJECTED' }): Promise<StepOutput> => {
    const d = await mustDoc(deps.store, i.doc_id);
    const base = { ...d, task_token: undefined, updated_at: now() };
    const next: DocumentRecord =
      i.outcome === 'PUBLISHED' ? { ...base, lifecycle: 'PUBLISHED' }
      : i.outcome === 'BLOCKED' ? { ...base, lifecycle: 'BLOCKED', trust_gate_result: 'QUARANTINED' }
      : base; // REJECTED: 승인 API가 이미 BLOCKED(반려) 또는 IN_REVIEW(재검증)로 바꿈
    await deps.store.putDoc(next);
    await deps.store.audit({ at: now(), actor: 'system:finalize', action: `FINALIZE_${i.outcome}`, resource: d.doc_id, result: 'OK', trace_id: i.workflow_id });
    return { status: 'OK' };
  };
}
