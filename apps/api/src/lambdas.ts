// 단계 Lambda (Owner dhxorb96, docs/05 3장). 입출력 계약: interfaces.md 6장.
// 진입점은 handlers.ts. 여기 함수들은 의존성을 주입받아 테스트한다.
import { createHash } from 'node:crypto';
import { newId, type DocumentRecord, type Finding, type StepOutput } from './contracts.ts';
import type { Store } from './store.ts';
import { fileStructureCheck, typeDetection, type FileKind } from './steps/file-checks.ts';
import { trustGate, type RegistryEntry } from './steps/trust-gate.ts';
import { validateKnowhow, type KnowhowDeps } from './steps/knowhow.ts';
import { piiScan, type GuardrailCheck } from './steps/pii.ts';
import { injectionScan } from './steps/injection.ts';
import { staleKnowhow } from './steps/freshness.ts';
import { classifyPrompt, summaryPrompt, type ClassifyOut, type SummaryOut } from './steps/classify.ts';

export interface StepInput { workflow_id: string; doc_id: string; version: number; bucket: string; prefix: string; actor: { sub: string; groups: string[] } }

export interface LambdaDeps {
  store: Store;
  headObject(key: string): Promise<{ s3_version_id: string } | undefined>;
  getObjectBytes(key: string, versionId?: string, range?: number): Promise<Uint8Array>;
  startWorkflow(d: DocumentRecord): Promise<void>;
  /** 노하우 검증 의존성 (regulation·search Tool). 없으면 KNOWHOW 문서는 검증 대기로 사람 검토 */
  knowhow?: KnowhowDeps & { maskedText(d: DocumentRecord): Promise<string> };
  /** Trusted Registry 대조 (let522mj registryMatch). text 없이 부르면 해시만 대조 */
  registry?(content_hash: string, text?: string): Promise<{ registry?: RegistryEntry & { law_name?: string; effective_to?: string; registry_doc_no?: string }; claimed?: { law_id: string; revision_id: string; clauses?: Record<string, string> } }>;
  maskedText?(d: DocumentRecord): Promise<string>;
}

/** 단계 6·7·8 의존성. 6은 work/(원본 등급)을 읽고, 7·8은 masked/만 읽는다 (8은 모델 호출 Role, 원본 읽기 거부) */
export interface SegmentDeps {
  store: Store;
  listKeys(prefix: string): Promise<string[]>;
  getJson<T>(key: string): Promise<T>;
  putJson(key: string, v: unknown): Promise<void>;
  guardrail?: GuardrailCheck;
  classify?(tier: 'HAIKU' | 'SONNET', prompt: string): Promise<{ value: ClassifyOut; model: string }>;
  summarize?(prompt: string): Promise<{ value: SummaryOut; model: string }>;
}
type Seg = { page_index: number; text: string };
const pageOf = (k: string) => Number(/(\d{4})\.json$/.exec(k)?.[1] ?? NaN);

async function maskedSegments(deps: SegmentDeps, doc_id: string) {
  const keys = (await deps.listKeys(`${doc_id}/masked/segments/`)).filter((k) => k.endsWith('.json'));
  if (!keys.length) throw new Error('masked segments 없음'); // 빈 결과로 성공 처리 금지
  return Promise.all(keys.map((k) => deps.getJson<Seg>(k)));
}

/** 단계 6 PiiScan: work/segments → 정규식·체크섬 → Guardrails → masked/segments (Promote가 게시본으로 사용) */
export function makePiiScan(deps: SegmentDeps) {
  return async (i: StepInput): Promise<StepOutput> => {
    const d = await mustDoc(deps.store, i.doc_id);
    const keys = (await deps.listKeys(`${i.doc_id}/work/segments/`)).filter((k) => k.endsWith('.json'));
    if (!keys.length) throw new Error('segments 없음');
    const segs = await Promise.all(keys.map(async (k) => ({ page: pageOf(k), text: (await deps.getJson<Seg>(k)).text })));
    const r = await piiScan(segs, deps.guardrail);
    for (const m of r.masked)
      await deps.putJson(`${i.doc_id}/masked/segments/${String(m.page).padStart(4, '0')}.json`, { doc_id: i.doc_id, page_index: m.page, text: m.text });
    await deps.store.putDoc(addFindings(d, r.findings));
    return { status: r.status, output_key: `${i.doc_id}/masked/segments/`, findings: r.findings };
  };
}

/** 단계 7 InjectionScan: masked 텍스트만 */
export function makeInjectionScan(deps: SegmentDeps) {
  return async (i: StepInput): Promise<StepOutput> => {
    const d = await mustDoc(deps.store, i.doc_id);
    const r = injectionScan((await maskedSegments(deps, i.doc_id)).map((s) => ({ page: s.page_index, text: s.text })));
    await deps.store.putDoc(addFindings(d, r.findings));
    return r;
  };
}

/** 단계 8 Classify: masked 텍스트 앞 6,000자 + 제목 → Haiku(저신뢰 시 Sonnet), temperature 0, 구조화 출력 (docs/04 3장) */
export function makeClassify(deps: SegmentDeps) {
  return async (i: StepInput): Promise<StepOutput> => {
    if (!deps.classify) throw new Error('classify model not configured');
    const d = await mustDoc(deps.store, i.doc_id);
    const segs = (await maskedSegments(deps, i.doc_id)).sort((a, b) => a.page_index - b.page_index);
    const text = segs.map((s) => s.text).join('\n').slice(0, 6000);
    const prompt = classifyPrompt(d.title, text);
    let r = await deps.classify('HAIKU', prompt);
    if (r.value.confidence < 0.7) r = await deps.classify('SONNET', prompt); // 에스컬레이션 (docs/01 9장)
    const v = r.value;
    // 요약 실패는 게시를 막지 않는다 (보관함에 요약 없음으로 표시)
    const sum = deps.summarize ? await deps.summarize(summaryPrompt(d.title, segs)).catch((e: Error) => { console.warn(JSON.stringify({ msg: 'summary failed', doc_id: d.doc_id, err: e.name })); return undefined; }) : undefined;
    const findings: Finding[] = v.confidence < 0.7
      ? [{ finding_id: newId.fnd(), step: 'CLASSIFY', severity: 'MEDIUM', code: 'CLASSIFY_LOW_CONFIDENCE', message: `분류 신뢰도 ${v.confidence.toFixed(2)} → 작성자 확인 필요`, evidence_ref: r.model }]
      : [];
    await deps.store.putDoc({
      ...addFindings(d, findings),
      document_type: v.document_type, // Promote가 최상위 document_type을 읽는다 (let522mj)
      classification: { document_type: v.document_type, business_path: v.business_path, tags: v.tags, confidence: v.confidence, rationale: v.rationale, source: 'MODEL' },
      ...(sum ? { summary: sum.value.summary, page_summaries: sum.value.pages } : {}),
    });
    return { status: findings.length ? 'REVIEW_REQUIRED' : 'OK', findings };
  };
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
    // Registry 대조: 해시가 기준본과 같으면 그 개정본. 아니면 REGULATION으로 분류된 문서만 본문 머리말로 주장 개정본을 찾는다
    // (노하우 머리말의 규정명 언급을 '공식 규정 주장'으로 오인하지 않기 위해)
    let match = deps.registry && d.content_hash ? await deps.registry(d.content_hash) : {};
    if (deps.registry && !match.registry && d.classification?.document_type === 'REGULATION' && deps.maskedText)
      match = await deps.registry(d.content_hash ?? '', await deps.maskedText(d));
    const g = trustGate({ doc: d, claimed: match.claimed, registry: match.registry });
    const reg = g.authority_status === 'VERIFIED' && match.registry ? match.registry : undefined;
    let result = g.result;
    let findings = g.findings;
    let extra: Partial<DocumentRecord> = {};
    if (d.classification?.document_type === 'KNOWHOW' && result !== 'QUARANTINED') {
      if (!deps.knowhow) {
        findings = [...findings, { finding_id: newId.fnd(), step: 'TRUST_GATE', severity: 'MEDIUM', code: 'KNOWHOW_VALIDATION_PENDING', message: '노하우 검증 Tool 미연결 → 사람 검토', evidence_ref: 'config' }];
        result = 'REVIEW_REQUIRED';
      } else {
        const k = await validateKnowhow(await deps.knowhow.maskedText(d), deps.knowhow);
        findings = [...findings, ...k.findings];
        if (k.gate === 'REVIEW_REQUIRED') result = 'REVIEW_REQUIRED';
        extra = { knowhow_validation: k.validation, ...(k.freshness ? { freshness: k.freshness } : {}) };
      }
    }
    const regFields: Partial<DocumentRecord> = reg ? { // Promote는 REGULATION이면 law_id·revision_id 필수 (let522mj)
      law_id: reg.law_id, revision_id: reg.revision_id, effective_from: reg.effective_from,
      ...(reg.law_name ? { law_name: reg.law_name } : {}), ...(reg.effective_to ? { effective_to: reg.effective_to } : {}), ...(reg.registry_doc_no ? { registry_doc_no: reg.registry_doc_no } : {}),
    } : {};
    await deps.store.putDoc({ ...addFindings(d, findings), ...extra, ...regFields, trust_gate_result: result, authority_status: g.authority_status });
    return { status: result === 'PASS' ? 'OK' : result === 'QUARANTINED' ? 'BLOCKED' : 'REVIEW_REQUIRED', findings };
  };
}

/** 검토 대기 (AgentCore 오케스트레이터의 await_review Tool). 문서를 IN_REVIEW로 둔다 */
export function makeWaitForApproval(deps: LambdaDeps) {
  return async (i: StepInput) => {
    const d = await mustDoc(deps.store, i.doc_id);
    // 게시·승인 대기·차단된 문서를 다시 검토 대기로 되돌리지 않는다 (재실행 안전장치)
    if (d.lifecycle !== 'QUARANTINED' && d.lifecycle !== 'IN_REVIEW') throw new Error(`invalid lifecycle for review: ${d.lifecycle}`);
    await deps.store.putDoc({ ...d, lifecycle: 'IN_REVIEW', updated_at: now() });
    return { status: 'OK' };
  };
}

/** 단계 14. outcome에 따라 최종 상태. 승인 레코드 USED 전환은 Promote(let522mj)가 한다 */
export function makeFinalize(deps: LambdaDeps) {
  return async (i: StepInput & { outcome: 'PUBLISHED' | 'BLOCKED' | 'REJECTED' }): Promise<StepOutput> => {
    const d = await mustDoc(deps.store, i.doc_id);
    const base = { ...d, updated_at: now() };
    const next: DocumentRecord =
      i.outcome === 'PUBLISHED' ? { ...base, lifecycle: 'PUBLISHED' }
      : i.outcome === 'BLOCKED' ? { ...base, lifecycle: 'BLOCKED', trust_gate_result: 'QUARANTINED' }
      : base; // REJECTED: 승인 API가 이미 BLOCKED(반려) 또는 IN_REVIEW(재검증)로 바꿈
    await deps.store.putDoc(next);
    await deps.store.audit({ at: now(), actor: 'system:finalize', action: `FINALIZE_${i.outcome}`, resource: d.doc_id, result: 'OK', trace_id: i.workflow_id });
    // 규정 개정판 게시 → 그 규정을 근거로 쓴 게시 노하우를 재검토 대상으로 (시행 전 개정판이면 시행일 점검(freshnessSweep)에서)
    if (i.outcome === 'PUBLISHED' && next.document_type === 'REGULATION' && next.law_id) await markStale(deps.store, [next.law_id], i.workflow_id);
    return { status: 'OK' };
  };
}

async function markStale(store: Store, lawIds: string[] | undefined, trace_id: string) {
  const stale = staleKnowhow(await store.listDocs(), undefined, lawIds);
  for (const d of stale) {
    await store.putDoc(d);
    await store.audit({ at: now(), actor: 'system:freshness', action: 'FRESHNESS_REVIEW_REQUIRED', resource: d.doc_id, result: 'OK', trace_id });
  }
  return stale.length;
}

/** 일 1회 (EventBridge 스케줄): 시행일이 된 개정판을 근거로 한 게시 노하우 재검토 표시 */
export function makeFreshnessSweep(deps: Pick<LambdaDeps, 'store'>) {
  return async () => ({ marked: await markStale(deps.store, undefined, `sweep-${now()}`) });
}
