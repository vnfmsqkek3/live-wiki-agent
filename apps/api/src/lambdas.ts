// 단계 Lambda (Owner dhxorb96, docs/05 3장). 입출력 계약: interfaces.md 6장.
// 진입점은 handlers.ts. 여기 함수들은 의존성을 주입받아 테스트한다.
import { applyCarry } from './steps/carry.ts';
import { createHash } from 'node:crypto';
import { newId, type DocumentRecord, type Finding, type StepOutput } from './contracts.ts';
import type { Store } from './store.ts';
import { fileStructureCheck, typeDetection, type FileKind } from './steps/file-checks.ts';
import { trustGate, type RegistryEntry } from './steps/trust-gate.ts';
import { validateKnowhow, type KnowhowDeps } from './steps/knowhow.ts';
import { piiScan, type GuardrailCheck } from './steps/pii.ts';
import { injectionScan } from './steps/injection.ts';
import { staleKnowhow } from './steps/freshness.ts';
import { blackout, piiBoxes, type OcrPage } from './steps/image-mask.ts';
import { docDates, primaryDate, titleCandidate } from '@hanaeum/legal-parser';
import { editReview } from './steps/edit-review.ts';
import { sitesOf, unsafeQuery } from './steps/reference-check.ts';
import type { WebHit } from './web-search.ts';
import { allocate, asRef, findInSameDoc, linkAcceptable, ruleCandidates, sitesFor, webQuery, clarifyPrompt, clarifySeverity, keepCandidates, safeSuggestion, suggestPrompt, WEB_KINDS, type ClarifyCandidate, type ClarifyData, type ClarifySuggestion, type WikiHit } from './steps/clarify.ts';
import { sameText } from './claims.ts';
import { faithful, needsStructure, structurePrompt, textFallback, tightTables } from './steps/structure.ts';
import { detectPii, mask } from './steps/pii-detect.ts';
import { classifyPrompt, summaryPrompt, type ClassifyOut, type SummaryOut } from './steps/classify.ts';

export interface StepInput { workflow_id: string; doc_id: string; version: number; bucket: string; prefix: string; actor: { sub: string; groups: string[] } }

export interface LambdaDeps {
  store: Store;
  headObject(key: string): Promise<{ s3_version_id: string } | undefined>;
  getObjectBytes(key: string, versionId?: string, range?: number): Promise<Uint8Array>;
  startWorkflow(d: DocumentRecord): Promise<void>;
  /** 노하우 검증 의존성 (regulation·search Tool). 없으면 KNOWHOW 문서는 검증 대기로 사람 검토 */
  knowhow?: KnowhowDeps & { maskedText(d: DocumentRecord): Promise<string> };
  /** 주장 저장 (interfaces.md 10.2, PostgreSQL). 노하우 검증 items 그대로. 없으면 생략 */
  saveClaims?(doc_id: string, items: import('./steps/knowhow.ts').KnowhowValidation['items'], pageOf: (statement: string) => number | null, revisedTo?: (provision_id: string) => Promise<string | undefined>): Promise<unknown>;
  /** Trusted Registry 대조 (let522mj registryMatch). text 없이 부르면 해시만 대조 */
  registry?(content_hash: string, text?: string): Promise<{ registry?: RegistryEntry & { law_name?: string; effective_to?: string; registry_doc_no?: string }; claimed?: { law_id: string; revision_id: string; clauses?: Record<string, string> } }>;
  maskedText?(d: DocumentRecord): Promise<string>;
  /** 저장소 prefix 아래 모든 버전 삭제 (차단·반려 문서 정리). 지운 수 */
  purge?(prefix: string): Promise<number>;
  /** 마스킹 페이지 (Finding 쪽 번호 찾기) */
  maskedPages?(d: DocumentRecord): Promise<{ page: number; text: string }[]>;
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
  /** 업무 분류 칸 배정 (interfaces.md 10.1). 마스킹된 제목·요약만. 없으면 생략 (GOV_STORE=postgres + MODEL_EMBED 일 때만) */
  category?(doc: { doc_id: string; title: string; summary?: string }): Promise<unknown>;
  /** 참조 확인 (interfaces 6.4): 정리본에서 확인할 대상 찾기(Haiku)와 공개 웹 검색(AgentCore Browser). 없으면 생략 */
  /** 확인 필요 찾기 (계약 6.5) */
  findClarify?(prompt: string): Promise<{ value: { items: ClarifyCandidate[] }; model: string }>;
  /** 위키 조각으로 채울 값 제안 */
  suggestClarify?(prompt: string): Promise<{ value: { suggestions: { n: number; value: string; after: string; source_id: string }[] } }>;
  /** 사내 위키 검색 (게시 문서, 같은 분류 우선) */
  wiki?(query: string, categoryPath?: string): Promise<WikiHit[]>;
  /** 이 문서의 업무 분류 경로 (위키 검색 같은 분류 우선) */
  categoryOf?(doc_id: string): Promise<string | undefined>;
  web?: import('./web-search.ts').WebSearcher;
  /** 쪽 본문 AI 재구성 (마스킹본만 입력, 마크다운). 없으면 생략 */
  structure?(prompt: string): Promise<{ value: { markdown: string }; model: string }>;
  /** 페이지 이미지 마스킹(13항). 없으면 이미지 단계 생략 */
  getBytes?(key: string): Promise<Uint8Array>;
  putBytes?(key: string, body: Uint8Array, contentType: string): Promise<void>;
}
/** page_markdown: 그림 쪽을 Vision 이 쪽 이미지 기준으로 쓴 정리본 (ImageDescribe, 사용자 결정 11/17 A). 원문 대조 대상 아님 */
type Seg = { page_index: number; text: string; figures?: import('./steps/structure.ts').PageFigure[]; page_markdown?: string };
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
    const raw = await Promise.all(keys.map(async (k) => ({ page: pageOf(k), seg: await deps.getJson<Seg & { figure_boxes?: number[][] }>(k) })));
    const r = await piiScan(raw.map((x) => ({ page: x.page, text: x.seg.text })), deps.guardrail);
    // figure_boxes(그림 영역 좌표 0~1000, let522mj SegmentBuild)는 좌표뿐이라 그대로 넘긴다 → ImageDescribe 가 그림을 자를 때 씀
    const boxesOf = new Map(raw.map((x) => [x.page, x.seg.figure_boxes]));
    for (const m of r.masked) {
      const fb = boxesOf.get(m.page);
      await deps.putJson(`${i.doc_id}/masked/segments/${String(m.page).padStart(4, '0')}.json`, { doc_id: i.doc_id, page_index: m.page, text: m.text, ...(Array.isArray(fb) && fb.length ? { figure_boxes: fb } : {}) });
    }
    const img = await maskPageImages(deps, i.doc_id);
    const findings = [...(r.findings ?? []), ...img];
    await deps.store.putDoc(addFindings(d, findings));
    const status = r.status === 'OK' && img.length ? 'REVIEW_REQUIRED' : r.status;
    return { status, output_key: `${i.doc_id}/masked/segments/`, findings };
  };
}

/** 그림이 있는 페이지: OCR 블록 중 개인정보 bbox를 검게 칠한 masked/pages/{nnnn}.png (ImageDescribe의 유일한 입력).
 *  얼굴·서명 같은 이미지 개인정보는 글자로 판정할 수 없어 페이지 단위 PII_IMAGE_REVIEW(사람 확인). OCR이 없는 페이지는 이미지를 만들지 않는다 */
async function maskPageImages(deps: SegmentDeps, doc_id: string): Promise<Finding[]> {
  if (!deps.getBytes || !deps.putBytes) return [];
  const targets = await deps.getJson<{ pages: { page_index: number; reason: string; has_images?: boolean }[] }>(`${doc_id}/work/pages/ocr_targets.json`).catch(() => undefined);
  const ocr = await deps.getJson<{ pages: (OcrPage & { figures?: { label: string }[] })[] }>(`${doc_id}/work/ocr/result.json`).catch(() => undefined);
  // 그림 쪽 기준 (사용자 결정 11/17, 비전 중복 줄이기): OCR 쪽에 figures 키가 있으면 사진·그림·차트·도장 영역이 있는 쪽만.
  // 없으면(이전 OCR) has_images || reason==='image'. 글자·표만 있는 쪽은 masked/pages를 만들지 않아 ImageDescribe가 빠진다
  const isFigurePage = (p: { page_index: number; reason: string; has_images?: boolean }) => {
    const o = ocr?.pages.find((x) => x.page_index === p.page_index);
    return o && Array.isArray(o.figures) ? o.figures.length > 0 : !!p.has_images || p.reason === 'image';
  };
  // 원본 보기(사용자 요청 11/17 '원본 내용 그대로 png'): 모든 쪽을 개인정보만 검게 칠한 이미지로 masked/view/ 에 (OCR 이 있는 쪽).
  // 그림 쪽은 같은 이미지를 masked/pages/ 에도 둔다(ImageDescribe 입력, 기존 그대로)
  const out: Finding[] = [];
  for (const p of targets?.pages ?? []) {
    const n = String(p.page_index).padStart(4, '0');
    const o = ocr?.pages.find((x) => x.page_index === p.page_index);
    const fig = isFigurePage(p);
    if (!o) {
      if (fig) out.push({ finding_id: newId.fnd(), step: 'PII_SCAN', severity: 'MEDIUM', code: 'PII_IMAGE_REVIEW', message: `${p.page_index + 1}쪽 그림: 글자 위치 정보가 없어 그림 속 개인정보를 가리지 못했습니다. AI 그림 분석에서 제외, 사람 확인 필요`, evidence_ref: `page:${p.page_index}`, location: { page: p.page_index + 1 } });
      continue;
    }
    const boxes = await piiBoxes(o, deps.guardrail);
    const png = blackout(await deps.getBytes(`${doc_id}/work/pages/${n}.png`), boxes, o);
    await deps.putBytes(`${doc_id}/masked/view/${n}.png`, png, 'image/png');
    if (!fig) continue;
    await deps.putBytes(`${doc_id}/masked/pages/${n}.png`, png, 'image/png');
    out.push({ finding_id: newId.fnd(), step: 'PII_SCAN', severity: 'MEDIUM', code: 'PII_IMAGE_REVIEW', message: `${p.page_index + 1}쪽 그림: 글자 개인정보 ${boxes.length}곳 가림. 얼굴·서명 등 그림 속 개인정보는 사람 확인 필요`, evidence_ref: `page:${p.page_index}`, location: { page: p.page_index + 1 } });
  }
  return out;
}

/** 단계 7 InjectionScan: masked 텍스트만 */
export function makeInjectionScan(deps: SegmentDeps) {
  return async (i: StepInput): Promise<StepOutput> => {
    const d = await mustDoc(deps.store, i.doc_id);
    // Vision 정리본(page_markdown)도 검사: 모델 출력이지만 이미지 속 지시문이 옮겨질 수 있다
    const r = injectionScan((await maskedSegments(deps, i.doc_id)).map((s) => ({ page: s.page_index, text: s.page_markdown ? `${s.text}\n${s.page_markdown}` : s.text })));
    await deps.store.putDoc(addFindings(d, r.findings));
    return r;
  };
}

/** 참조 확인 ReferenceCheck (사용자 결정 11/18, interfaces 6.4). Classify 뒤, 게시를 막지 않는다(INFO). 어떤 실패도 OK 로 끝낸다 */
export function makeReferenceCheck(deps: SegmentDeps) {
  return async (i: StepInput): Promise<StepOutput> => {
    if (!deps.findClarify) return { status: 'OK', findings: [] };
    // 규정은 위키에서 고칠 수 없어 '확인 필요' 질문을 만들지 않는다 (11/18 dev 시험)
    if (((await deps.store.getDoc(i.doc_id))?.document_type ?? '') === 'REGULATION') return { status: 'OK', findings: [] };
    // 전체 시간 예산 240초: Gateway 가 도구 호출을 ~300초에 끊는다 (11/18 dev 과천 가상판 실패). 넘으면 남은 웹 검색은 건너뛴다
    const t0 = Date.now(); const budget = Number(process.env.REFCHECK_BUDGET_MS ?? 240_000);
    const left = () => budget - (Date.now() - t0);
    const d = await mustDoc(deps.store, i.doc_id);
    try {
      // 정리본이 있으면 정리본, 없으면 마스킹 본문 (모두 개인정보를 가린 글). 적용은 화면이 이 글 기준으로 before→after
      const segs = (await maskedSegments(deps, i.doc_id)).sort((a, b) => a.page_index - b.page_index);
      const structured = new Map<number, string>();
      for (const k of (await deps.listKeys(`${i.doc_id}/masked/structured/`)).filter((x) => x.endsWith('.json'))) {
        const v = await deps.getJson<{ page_index: number; markdown: string }>(k).catch(() => undefined);
        if (v) structured.set(v.page_index, v.markdown);
      }
      const pages = segs.map((s) => ({ page: s.page_index + 1, text: structured.get(s.page_index) ?? s.text }));
      const all = pages.map((p) => p.text).join('\n\n');
      // 1) 찾기 (한 번에 모두: 링크 3 + 그 밖 12, CLARIFY_MAX)
      // 쪽 묶음(8쪽)마다 같은 체크리스트로 훑는다: 긴 입력의 자유 판단을 줄여 실행마다 달라지는 것을 줄인다 (11/18 dev)
      const chunks: (typeof pages)[] = []; for (let k = 0; k < pages.length; k += 8) chunks.push(pages.slice(k, k + 8));
      const results = d.review_carry ? [] : await Promise.all(chunks.map((ch) => deps.findClarify!(clarifyPrompt(d.title, ch)).catch(() => ({ value: { items: [] as ClarifyCandidate[] }, model: '' }))));
      const found = { model: results.find((r) => r.model)?.model ?? '', value: { items: results.flatMap((r) => r.value.items ?? []) } };
      // 모델은 담당자·불일치·버전만, 링크·표 빈 칸은 코드 탐지 (Fable 진단 D)
      // 한 번 검토한 뒤(위키 수정·다시 분석)에는 모델 질문을 새로 만들지 않는다: 실행마다 다른 질문이 나와 끝나지 않았다 (사용자 지적 11/18, Fable D). 규칙 질문만 고친 줄에서
      const llm = d.review_carry ? [] : found.value.items.filter((c) => ['VAGUE_ACTOR', 'INCONSISTENT', 'OUTDATED'].includes(c.kind));
      const pageText = (n: number) => pages.find((p) => p.page === n)?.text;
      const cands = allocate(keepCandidates([...ruleCandidates(pages), ...llm], all, pageText, pages), pageText);
      // 같은 문서 다른 쪽에 답이 있으면 'n쪽 참조' 제안 (잠금 여부는 바꾸지 않는다)
      const inDoc = new Map<number, { from: number; to: number; heading?: string }>();
      cands.forEach((c, n) => { if (c.kind === 'VAGUE_ACTOR' || c.kind === 'MISSING_VALUE') { const f = findInSameDoc(c, pages); if (f) inDoc.set(n, f); } });
      console.log(JSON.stringify({ msg: 'clarify candidates', doc_id: d.doc_id, n: cands.length, kinds: cands.map((c) => c.kind) }));
      const internal = (process.env.INTERNAL_DOMAINS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      const sugg = new Map<number, ClarifySuggestion[]>(cands.map((_, n) => [n, []]));
      for (const [n, f] of inDoc) {
        const where = `${f.from === f.to ? f.from : `${f.from}~${f.to}`}쪽${f.heading ? ` '${f.heading}'` : ''}`;
        sugg.get(n)!.push({ value: `${where} 참조`, after: `${cands[n]!.before.replace(/\s+$/, '')} (${where} 참조)`, source: { type: 'WIKI', doc_id: d.doc_id, page: f.from, title: '이 문서' } });
      }
      // 2) 사내 위키 먼저 (게시 문서만, 자기 문서 제외, 같은 분류 우선). 검색어 검사를 통과한 것만
      if (deps.wiki && deps.suggestClarify) {
        const qs: { n: number; c: ClarifyCandidate; hits: WikiHit[] }[] = [];
        const category = await deps.categoryOf?.(d.doc_id).catch(() => undefined);
        await Promise.all(cands.map(async (c, n) => {
          const why = unsafeQuery(c.query); if (why && why !== 'internal_domain') return; // 사내 검색이라 '하나은행'·사내 도메인 낱말은 허용, 개인정보·사람 이름은 금지
          const hits = (await deps.wiki!(c.query, category).catch(() => [] as WikiHit[])).filter((h) => h.doc_id !== d.doc_id && h.doc_id !== d.previous_doc_id).slice(0, 4);
          if (hits.length) qs.push({ n, c, hits });
        }));
        if (qs.length) {
          const out = (await deps.suggestClarify(suggestPrompt(qs)).catch(() => ({ value: { suggestions: [] } }))).value.suggestions ?? [];
          for (const s of out) {
            const q = qs.find((x) => x.n === s.n); const h = q?.hits.find((x) => x.id === s.source_id);
            if (!q || !h || !safeSuggestion(q.c, s)) continue;
            sugg.get(s.n)!.push({ value: s.value.trim(), after: s.after.trim(), source: { type: 'WIKI', doc_id: h.doc_id, title: h.title, ...(h.page ? { page: h.page } : {}) } });
          }
        }
      }
      // 3) 공개 웹은 링크·불일치·버전만, 위키 제안이 없을 때, 공식 도메인 추정이 있을 때 (최대 3건)
      const webC = cands.map((c, n) => {
        const pt = c.page ? pageText(c.page) ?? '' : '';
        const q = webQuery(c, pt);
        return { c, n, q, sites: sitesFor(`${c.before} ${c.item} ${pt}`, sitesOf(asRef(c))) };
      }).filter(({ c, n, q, sites }) => WEB_KINDS.has(c.kind) && !sugg.get(n)!.length && q && sites.length && !unsafeQuery(q, internal)).slice(0, 3);
      const checked_at = now();
      if (deps.web && webC.length) {
        // 채택 판정을 검색 안으로: 채택할 수 있는 결과가 나올 때까지 사이트별 site: 검색 → 일반 검색 (Fable 진단 C)
        const sitesM = new Map(webC.map(({ q, sites }) => [q!, sites])); const acceptM = new Map(webC.map(({ q, sites }) => [q!, linkAcceptable(all, sites)]));
        // 검색어마다 따로(동시 2개), 각 60초·남은 예산 안에서. 시간 초과면 그 검색어는 빈 결과
        const one = (q: string) => {
          const ms = Math.min(60_000, left() - 15_000);
          if (ms <= 5_000) { console.log(JSON.stringify({ msg: 'refcheck web skipped', doc_id: d.doc_id, reason: 'budget' })); return Promise.resolve(new Map<string, WebHit[]>()); }
          return Promise.race([deps.web!.search([q], sitesM, acceptM).catch(() => new Map<string, WebHit[]>()),
            new Promise<Map<string, WebHit[]>>((r) => setTimeout(() => { console.log(JSON.stringify({ msg: 'refcheck web timeout', doc_id: d.doc_id, ms })); r(new Map()); }, ms))]);
        };
        const run = async (qs: string[]) => { const out = new Map<string, WebHit[]>(); for (let k = 0; k < qs.length; k += 2) for (const m of await Promise.all(qs.slice(k, k + 2).map(one))) for (const [q, h] of m) out.set(q, h); return out; };
        const hits = await run([...new Set(webC.map(({ q }) => q!))]);
        // 웹 결과는 실행마다 달라진다: 채택할 결과가 없는 검색어는 남은 시간이 있을 때만 한 번 더 (11/18 dev 1회차 빈 제안)
        const retry = webC.filter(({ q, sites }) => !(hits.get(q!) ?? []).some(linkAcceptable(all, sites))).map(({ q }) => q!);
        if (retry.length && left() > 75_000) for (const [q, h] of await run([...new Set(retry)])) hits.set(q, [...(hits.get(q) ?? []), ...h]);
        console.log(JSON.stringify({ msg: 'refcheck web', doc_id: d.doc_id, queries: webC.length, results: [...hits.values()].map((h) => h.length), accepted: webC.map(({ q, sites }) => (hits.get(q!) ?? []).filter(linkAcceptable(all, sites)).length), left_ms: left() }));
        for (const q of hits.keys()) await deps.store.audit({ at: checked_at, actor: 'system:reference-check', action: 'WEB_SEARCH', resource: d.doc_id, result: 'OK', trace_id: i.workflow_id,
          detail: { query: q, results: hits.get(q)!.length, urls: hits.get(q)!.map((h) => h.url) } });
        for (const { c, n, q, sites } of webC) {
          const ok = (hits.get(q!) ?? []).filter(linkAcceptable(all, sites)).sort((x, y) => new URL(x.url).pathname.length - new URL(y.url).pathname.length); // 짧은 경로 우선
          const h = ok[0];
          if (h) sugg.get(n)!.push({ value: h.url, after: `${c.before} (${h.url})`, source: { type: 'WEB', url: h.url, title: h.title } });
        }
      }
      // 4) finding: 제안이 없어도 질문은 남긴다
      const findings: Finding[] = cands.map((c, n) => {
        const data: ClarifyData = { kind: c.kind, item: c.item, ...(c.page ? { page: c.page } : {}), before: c.before, ...(c.span ? { span: c.span } : {}), ...(c.table_header ? { table_header: c.table_header } : {}), question: c.question, suggestions: sugg.get(n)!, status: 'OPEN' };
        return { finding_id: newId.fnd(), step: 'REFERENCE_CHECK', severity: clarifySeverity(c, c.page ? pageText(c.page) : undefined), code: 'CLARIFY_NEEDED', message: `확인 필요: ${c.kind}`, evidence_ref: found.model,
          location: { ...(c.page ? { page: c.page } : {}), excerpt: c.before.slice(0, 120) },
          user_message: c.question, fix_hint: data.suggestions.length ? '제안을 확인하고 [적용]하거나 직접 입력하세요.' : '직접 입력하거나, 해당 없으면 사유를 적어 주세요.',
          details: { ...data, checked_at } };
      });
      if (findings.length) await deps.store.putDoc(addFindings(await mustDoc(deps.store, i.doc_id), findings)); // 검색 중 다른 단계가 바꾼 문서 위에 더함
      console.log(JSON.stringify({ msg: 'clarify done', doc_id: d.doc_id, items: findings.length, with_suggestion: findings.filter((f) => (f.details as unknown as ClarifyData).suggestions.length).length, blocking: findings.filter((f) => f.severity === 'MEDIUM').length }));
      return { status: 'OK', findings };
    } catch (e) {
      console.warn(JSON.stringify({ msg: 'clarify failed', doc_id: d.doc_id, err: (e as Error).name }));
      return { status: 'OK', findings: [] };
    }
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
    // 본문 일자(시행·개정·작성 …)와 자동 제목 (사용자 요청 11/17). 제목은 작성자가 비워 둔 경우만 바꾼다
    const texts = segs.map((s) => s.text);
    const dates = docDates(texts).map((x) => ({ ...x, page: segs[x.page]?.page_index ?? x.page }));
    const main = primaryDate(dates);
    const autoTitle = d.title_source === 'AUTO' ? (sum?.value.title?.replace(/^\[?SYNTHETIC\]?\s*/u, '').trim().slice(0, 60) || titleCandidate(texts, d.filename ?? '') || d.title) : undefined;
    // 쪽 본문 AI 재구성 → masked/structured/{nnnn}.json. 원문과 같은 글이 아니면 저장하지 않는다(화면은 원문). 실패는 게시를 막지 않는다
    if (deps.structure) await structurePages(deps, i.doc_id, segs);
    await deps.store.putDoc({
      ...addFindings(d, findings),
      ...(autoTitle ? { title: autoTitle } : {}),
      ...(dates.length ? { doc_dates: dates, ...(main ? { doc_date: main } : {}) } : {}),
      // 사람이 정한 문서 종류는 다시 분석해도 바꾸지 않는다 (11/18 prod 시험: 노하우로 바꾼 뒤 재분석이 매뉴얼로 되돌림)
      ...(d.classification?.source === 'HUMAN' ? {} : {
        document_type: v.document_type, // Promote가 최상위 document_type을 읽는다 (let522mj)
        classification: { document_type: v.document_type, business_path: v.business_path, tags: v.tags, confidence: v.confidence, rationale: v.rationale, source: 'MODEL' as const },
      }),
      ...(sum ? { summary: sum.value.summary, page_summaries: sum.value.pages } : {}),
    });
    // 업무 분류 칸 배정: 실패해도 게시는 막지 않는다 (주기 정리·보충 스크립트가 다시 배정)
    if (deps.category) await deps.category({ doc_id: d.doc_id, title: autoTitle ?? d.title, summary: sum?.value.summary ?? d.summary })
      .catch((e: Error) => console.warn(JSON.stringify({ msg: 'category failed', doc_id: d.doc_id, err: e.name })));
    return { status: findings.length ? 'REVIEW_REQUIRED' : 'OK', findings };
  };
}

/** 쪽마다 Haiku 1회(동시 4), 짧은 쪽(80자 미만)·이미 마크다운인 쪽은 건너뜀. 원문 대조를 통과한 정리본만 저장 */
export async function structurePages(deps: Pick<SegmentDeps, 'structure' | 'putJson'>, doc_id: string, segs: Seg[]) {
  // 그림 쪽 Vision 정리본은 모델을 다시 부르지 않고 그대로 쓴다 (다시 가린 뒤). 원문 대조 대상 아님 → 화면에 '그림 기준' 표시
  for (const s of segs) if (s.page_markdown?.trim()) {
    const md = mask(s.page_markdown, detectPii(s.page_markdown)).replace(/_\((그림\s*\d+)\)_/gu, '($1)').slice(0, 6000); // '_(그림 n)_' → 화면 단추가 되는 '(그림 n)'
    await deps.putJson(`${doc_id}/masked/structured/${String(s.page_index).padStart(4, '0')}.json`, { page_index: s.page_index, markdown: tightTables(md), source: 'VISION', at: now() }).catch(() => {});
  }
  const todo = segs.filter((s) => !s.page_markdown?.trim() && needsStructure(s.text, s.figures)).slice(0, 40);
  let saved = 0, rejected = 0, failed = 0;
  const done = new Set<number>();
  for (let k = 0; k < todo.length; k += 4) {
    await Promise.all(todo.slice(k, k + 4).map(async (s) => {
      try {
        const pv = segs.find((x) => x.page_index === s.page_index - 1);
        const prevTail = (pv?.page_markdown?.trim() ? pv.page_markdown : pv?.text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-5).join('\n');
        const r = await deps.structure!(structurePrompt(s.page_index, s.text, s.figures, mask(prevTail, detectPii(prevTail))));
        const md = mask(r.value.markdown ?? '', detectPii(r.value.markdown ?? '')); // 모델 출력도 다시 가린다
        const f = faithful(s.text, md, s.figures);
        if (!f.ok) { rejected++; console.warn(JSON.stringify({ msg: 'structure rejected', doc_id, page: s.page_index, missing: f.missing.toFixed(3), extra: f.extra.toFixed(3), newNumbers: f.newNumbers.length })); return; }
        await deps.putJson(`${doc_id}/masked/structured/${String(s.page_index).padStart(4, '0')}.json`, { page_index: s.page_index, markdown: tightTables(md), source: 'AI', model: r.model, at: now() });
        saved++; done.add(s.page_index);
      } catch (e) { failed++; console.warn(JSON.stringify({ msg: 'structure failed', doc_id, page: s.page_index, err: (e as Error).name })); }
    }));
  }
  // 정리본이 없는 쪽(건너뜀·탈락·실패·40쪽 넘음)은 마스킹 본문을 정리본으로 둔다 → 정리본 탭은 모든 쪽이 글 (사용자 지적 11/18)
  const has = new Set([...segs.filter((s) => s.page_markdown?.trim()).map((s) => s.page_index), ...done]);
  const fb = textFallback(segs);
  let fallback = 0;
  for (const s of segs) if (!has.has(s.page_index)) {
    await deps.putJson(`${doc_id}/masked/structured/${String(s.page_index).padStart(4, '0')}.json`, { page_index: s.page_index, markdown: tightTables(fb.get(s.page_index) ?? '(빈 쪽)'), source: 'TEXT', at: now() }).catch(() => {});
    fallback++;
  }
  return { pages: todo.length, saved, rejected, failed, fallback };
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
        // 재검사에서 충돌이 사라지면 CURRENT로 되돌린다 (사용자 신고 11/19: 첫 검사의 충돌 표시가 고친 뒤 게시까지 남아 '재검토 필요')
        extra = { knowhow_validation: k.validation, freshness: k.freshness ?? 'CURRENT' };
      }
    }
    // 위키 수정본: 이전 버전과 비교 — 바뀐 문장에 대한 규정 판정만 남기고, 지운 중요 문장은 '고칠 것' (사용자 결정 11/17 규칙 2)
    if (d.source === 'WIKI_EDIT' && d.previous_doc_id && deps.knowhow && result !== 'QUARANTINED') {
      const prev = await deps.store.getDoc(d.previous_doc_id);
      if (prev) {
        const r = editReview(await deps.knowhow.maskedText(prev), await deps.knowhow.maskedText(d));
        findings = [...findings.filter((f) => !f.code.startsWith('KNOWHOW_CONFLICT') || r.onChanged(f)), ...r.findings];
        if (r.findings.length) result = 'REVIEW_REQUIRED';
        extra = { ...extra, edit_diff: { changed: r.changed.length, removed: r.removed.length } };
      }
    }
    // 매뉴얼도 본문이 인용한 규정 조문을 기록한다 → 규정·노하우와 서로 연결되고, 규정 개정 시 재검토 대상이 된다 (사용자 지시 11/17)
    if (d.classification?.document_type === 'MANUAL' && result !== 'QUARANTINED' && deps.knowhow) {
      const cites = (await deps.knowhow.extractCitations(await deps.knowhow.maskedText(d))).filter((c) => c.confidence >= 0.9);
      if (cites.length) extra = { ...extra, citations: cites };
    }
    const regFields: Partial<DocumentRecord> = reg ? { // Promote는 REGULATION이면 law_id·revision_id 필수 (let522mj)
      law_id: reg.law_id, revision_id: reg.revision_id, effective_from: reg.effective_from,
      ...(reg.law_name ? { law_name: reg.law_name } : {}), ...(reg.effective_to ? { effective_to: reg.effective_to } : {}), ...(reg.registry_doc_no ? { registry_doc_no: reg.registry_doc_no } : {}),
    } : {};
    if (deps.maskedPages && findings.some((f) => f.location?.excerpt && !f.location.page)) findings = withPages(findings, await deps.maskedPages(d));
    await deps.store.putDoc({ ...addFindings(d, findings), ...extra, ...regFields, trust_gate_result: result, authority_status: g.authority_status });
    // 주장 저장: 실패해도 검증 결과(문서 기록)는 남는다. 쪽은 마스킹본에서 문장 앞부분으로 찾는다
    const kv = extra.knowhow_validation;
    if (kv && deps.saveClaims) {
      const pages = deps.maskedPages ? await deps.maskedPages(d).catch(() => []) : [];
      const squash = (t: string) => t.replace(/\s/g, '');
      const pageOf = (st: string) => { const k = squash(st).slice(0, 30); const i = pages.findIndex((p) => squash(p.text).includes(k)); return i >= 0 ? (pages[i]!.page ?? i) + 1 : null; };
      const k = deps.knowhow!;
      const revisedTo = async (pid: string) => { const cl = await k.getClause(pid); return cl?.newer && (cl.newer.deleted || !sameText(cl.text, cl.newer.text)) ? cl.newer.provision_id : undefined; };
      await deps.saveClaims(d.doc_id, kv.items, pageOf, revisedTo).catch((e: Error) => console.warn(JSON.stringify({ msg: 'claims failed', doc_id: d.doc_id, err: e.name })));
    }
    return { status: result === 'PASS' ? 'OK' : result === 'QUARANTINED' ? 'BLOCKED' : 'REVIEW_REQUIRED', findings };
  };
}

/** 검토 대기 (AgentCore 오케스트레이터의 await_review Tool). 문서를 IN_REVIEW로 둔다 */
export function makeWaitForApproval(deps: LambdaDeps) {
  return async (i: StepInput) => {
    const d = await mustDoc(deps.store, i.doc_id);
    // 게시·승인 대기·차단된 문서를 다시 검토 대기로 되돌리지 않는다 (재실행 안전장치)
    if (d.lifecycle !== 'QUARANTINED' && d.lifecycle !== 'IN_REVIEW') throw new Error(`invalid lifecycle for review: ${d.lifecycle}`);
    await deps.store.putDoc({ ...d, lifecycle: 'IN_REVIEW', findings: applyCarry(d.review_carry, d.findings), checked_at: now(), updated_at: now() }); // checked_at: AI 검사 끝난 시각(도장 'AI 검사' 칸, 사용자 지적 11/18) // 위키 수정 전 결정 잇기 (steps/carry.ts)
    return { status: 'OK' };
  };
}

/** 단계 14. outcome에 따라 최종 상태. 승인 레코드 USED 전환은 Promote(let522mj)가 한다 */
export function makeFinalize(deps: LambdaDeps) {
  return async (i: StepInput & { outcome: 'PUBLISHED' | 'BLOCKED' | 'REJECTED' | 'DELETED'; affected_doc_ids?: string[] }): Promise<StepOutput> => {
    const d = await mustDoc(deps.store, i.doc_id);
    if (i.outcome === 'DELETED') return finalizeDeleted(deps.store, d, i.affected_doc_ids ?? [], i.workflow_id);
    const base = { ...d, updated_at: now() };
    const next: DocumentRecord =
      // 노하우·매뉴얼은 사람 승인이 곧 검증이다 (규정은 TrustGate Registry 대조로 VERIFIED). 승인·게시가 끝났으면 VERIFIED
      // 검사 단계의 충돌 표시(REVIEW_REQUIRED)는 승인자가 판단해 승인했으므로 게시 때 CURRENT. 개정 전 조문 인용(OUTDATED)·규정 변경 사유가 있으면 유지 (prod 2회차 H8 11/19)
      i.outcome === 'PUBLISHED' ? { ...base, lifecycle: 'PUBLISHED', ...(base.freshness === 'REVIEW_REQUIRED' && !base.freshness_reason && base.knowhow_validation?.verdict !== 'OUTDATED' ? { freshness: 'CURRENT' as const } : {}), ...(base.authority_status === 'UNVERIFIED' && (base.document_type ?? base.classification?.document_type) !== 'REGULATION' ? { authority_status: 'VERIFIED' as const } : {}) }
      : i.outcome === 'BLOCKED' ? { ...base, lifecycle: 'BLOCKED', trust_gate_result: 'QUARANTINED' }
      : base; // REJECTED: 승인 API가 이미 BLOCKED(반려) 또는 IN_REVIEW(재검증)로 바꿈
    await deps.store.putDoc(next);
    await deps.store.audit({ at: now(), actor: 'system:finalize', action: `FINALIZE_${i.outcome}`, resource: d.doc_id, result: 'OK', trace_id: i.workflow_id });
    // 규정 개정판 게시 → 그 규정을 근거로 쓴 게시 노하우를 재검토 대상으로 (시행 전 개정판이면 시행일 점검(freshnessSweep)에서)
    if (i.outcome === 'PUBLISHED' && (next.document_type ?? next.classification?.document_type) === 'REGULATION' && next.law_id) await markStale(deps.store, [next.law_id], i.workflow_id);
    // 새 규정 게시 → 근거 규정을 못 찾은 채 게시된 노하우를 다시 검증 (사용자 지적 11/18: 규정보다 먼저 게시된 체크리스트가 '정상'으로 남음)
    if (i.outcome === 'PUBLISHED' && (next.document_type ?? next.classification?.document_type) === 'REGULATION') await revalidateNoBasis(deps, next, i.workflow_id);
    // 새 버전 게시 → 이전 버전은 대체됨(검색은 SUPERSEDED를 내보내지 않음). 보관함에는 버전 목록으로 남는다
    if (i.outcome === 'PUBLISHED' && next.previous_doc_id) {
      const prev = await deps.store.getDoc(next.previous_doc_id);
      if (prev && prev.lifecycle === 'PUBLISHED') {
        await deps.store.putDoc({ ...prev, freshness: 'SUPERSEDED', superseded_by: next.doc_id, updated_at: now() });
        await deps.store.audit({ at: now(), actor: 'system:finalize', action: 'VERSION_SUPERSEDED', resource: prev.doc_id, result: 'OK', trace_id: i.workflow_id });
      }
    }
    // 검증에서 차단되거나 반려된 문서는 원본·작업 파일을 저장소에서 바로 지운다 (사용자 지시 11/17).
    // 개인정보를 가린 설명·쪽 이미지(masked/)는 올린 사람이 사유를 보도록 MASKED_RETENTION_DAYS 동안 남기고 freshnessSweep이 지운다
    if ((i.outcome === 'BLOCKED' || i.outcome === 'REJECTED') && deps.purge) await purgeOriginal(deps, next, i.workflow_id);
    return { status: 'OK' };
  };
}

/** excerpt(마스킹 문장)가 있는 쪽을 찾아 location.page(1부터)를 붙인다. 공백 차이는 무시 */
export function withPages(findings: Finding[], pages: { page: number; text: string }[]): Finding[] {
  const sq = (t: string) => t.replace(/\s+/g, '');
  const norm = pages.map((p) => ({ page: p.page, t: sq(p.text) }));
  return findings.map((f) => {
    const ex = f.location?.excerpt;
    if (!ex || f.location?.page) return f;
    const probe = sq(ex.replace(/^…|…$/g, '')).slice(0, 30);
    const hit = probe.length >= 6 ? norm.find((p) => p.t.includes(probe)) : undefined;
    return hit ? { ...f, location: { ...f.location, page: hit.page + 1 } } : f;
  });
}

/** 삭제 정리 마무리 (interfaces 6.0): 삭제된 규정의 조문을 근거로 쓰던 게시 문서를 재검토 대상으로, 정리 완료 시각 기록. 멱등 */
async function finalizeDeleted(store: Store, d: DocumentRecord, affected: string[], trace_id: string): Promise<StepOutput> {
  if (d.lifecycle !== 'DELETED') throw new Error('NotDeleted');
  const at = now();
  const marked: string[] = [];
  for (const id of [...new Set(affected)].filter((x) => x !== d.doc_id)) {
    const k = await store.getDoc(id);
    if (!k || k.lifecycle !== 'PUBLISHED') continue;
    const provisions = (k.knowhow_validation?.items ?? []).map((j) => j.provision_id).concat((k.citations ?? []).map((c) => c.provision_id)).filter((p) => !!d.law_id && p.startsWith(`${d.law_id}@`));
    await store.putDoc({
      ...k, freshness: 'REVIEW_REQUIRED', updated_at: at,
      freshness_reason: { law_id: d.law_id ?? d.doc_id, law_name: d.title, cited_revision: d.revision_id ?? '', current_revision: '', effective_from: '', provisions: [...new Set(provisions)], at, deleted_doc: d.doc_id },
    });
    await store.audit({ at, actor: 'system:finalize', action: 'FRESHNESS_REVIEW_REQUIRED', resource: id, result: 'OK', trace_id });
    marked.push(id);
  }
  const cur = (await store.getDoc(d.doc_id)) ?? d;
  await store.putDoc({ ...cur, purge: { ...cur.purge, objects: cur.purge?.objects ?? 0, deleted_at: at, review_required: marked } });
  await store.audit({ at, actor: 'system:finalize', action: 'FINALIZE_DELETED', resource: d.doc_id, result: 'OK', trace_id });
  return { status: 'OK' };
}

/** 근거 없이 게시된 노하우(KNOWHOW_NO_BASIS)를 새 규정과 다시 비교. 비교할 수 없으면(마스킹 본문 만료·도구 없음) 재검토 필요로만 표시. 어긋나면 재검토 필요 + 고칠 것 */
async function revalidateNoBasis(deps: LambdaDeps, reg: DocumentRecord, trace_id: string) {
  const targets = (await deps.store.listDocs()).filter((d) => d.lifecycle === 'PUBLISHED' && (d.document_type ?? d.classification?.document_type) === 'KNOWHOW'
    && d.freshness !== 'SUPERSEDED' && d.findings.some((f) => f.code === 'KNOWHOW_NO_BASIS'));
  // 시간 예산 240초: 도구 호출이 ~300초에 끊긴다(yoyo0704 권고 11/18). 넘으면 남은 건은 비교 없이 재검토 필요로만
  const t0 = Date.now(); const budget = Number(process.env.REVALIDATE_BUDGET_MS ?? 240_000);
  for (const d of targets) {
    const k = deps.knowhow && Date.now() - t0 < budget ? await deps.knowhow.maskedText(d).then((t) => validateKnowhow(t, deps.knowhow!)).catch(() => undefined) : undefined;
    const conflicts = k?.findings.filter((f) => f.code === 'KNOWHOW_CONFLICT').length ?? 0;
    const stillNone = !k || k.findings.some((f) => f.code === 'KNOWHOW_NO_BASIS');
    const cur = (await deps.store.getDoc(d.doc_id)) ?? d;
    const why = !k || conflicts > 0; // 비교 못 함 또는 어긋남 → 재검토 필요 (사유는 새 규정)
    await deps.store.putDoc({ ...cur,
      ...(k && !stillNone ? { knowhow_validation: k.validation, findings: [...cur.findings.filter((f) => f.code !== 'KNOWHOW_NO_BASIS' && f.code !== 'KNOWHOW_CONFLICT'), ...k.findings] } : {}),
      ...(why ? { freshness: 'REVIEW_REQUIRED' as const, freshness_reason: { law_id: reg.law_id ?? reg.doc_id, law_name: reg.law_name ?? reg.title, cited_revision: '', current_revision: reg.revision_id ?? '', effective_from: reg.effective_from ?? '', provisions: [], at: now() } } : {}), updated_at: now() });
    await deps.store.audit({ at: now(), actor: 'system:revalidate', action: why ? 'FRESHNESS_REVIEW_REQUIRED' : 'KNOWHOW_REVALIDATED', resource: d.doc_id, result: 'OK', trace_id, detail: { regulation: reg.doc_id, conflicts } });
  }
}

async function markStale(store: Store, lawIds: string[] | undefined, trace_id: string) {
  const stale = staleKnowhow(await store.listDocs(), undefined, lawIds);
  for (const d of stale) {
    await store.putDoc(d);
    await store.audit({ at: now(), actor: 'system:freshness', action: 'FRESHNESS_REVIEW_REQUIRED', resource: d.doc_id, result: 'OK', trace_id });
  }
  return stale.length;
}

export const MASKED_RETENTION_DAYS = 7;

async function purgeOriginal(deps: LambdaDeps, d: DocumentRecord, trace_id: string) {
  const n = (await deps.purge!(`${d.doc_id}/original.`)) + (await deps.purge!(`${d.doc_id}/work/`));
  const cur = (await deps.store.getDoc(d.doc_id)) ?? d;
  await deps.store.putDoc({ ...cur, purge: { ...cur.purge, original_at: now(), objects: (cur.purge?.objects ?? 0) + n }, updated_at: now() });
  await deps.store.audit({ at: now(), actor: 'system:finalize', action: 'PURGE_ORIGINAL', resource: d.doc_id, result: 'OK', trace_id });
}

/** 보관 기간이 지난 차단·반려 문서의 masked/ 삭제 (원본은 Finalize에서 이미 삭제). 멱등 */
export async function purgeExpiredMasked(deps: Pick<LambdaDeps, 'store' | 'purge'>, today = new Date()) {
  if (!deps.purge) return 0;
  const cutoff = new Date(today.getTime() - MASKED_RETENTION_DAYS * 86_400_000).toISOString();
  let done = 0;
  for (const d of await deps.store.listDocs()) {
    if (!['BLOCKED', 'DELETED'].includes(d.lifecycle) || d.purge?.masked_at || d.updated_at > cutoff) continue;
    if (d.lifecycle === 'DELETED' && !d.purge?.original_at) continue; // 게시본 폐기(retire)는 let522mj 절차가 따로 처리
    const n = await deps.purge(`${d.doc_id}/`);
    await deps.store.putDoc({ ...d, purge: { ...d.purge, masked_at: now(), objects: (d.purge?.objects ?? 0) + n } });
    await deps.store.audit({ at: now(), actor: 'system:sweep', action: 'PURGE_MASKED', resource: d.doc_id, result: 'OK', trace_id: `sweep-${now()}` });
    done++;
  }
  return done;
}

/** 일 1회 (EventBridge 스케줄): 시행일이 된 개정판을 근거로 한 게시 노하우 재검토 표시 + 보관 기간 지난 차단 문서 파일 삭제 */
export function makeFreshnessSweep(deps: Pick<LambdaDeps, 'store' | 'purge'>) {
  return async () => ({ marked: await markStale(deps.store, undefined, `sweep-${now()}`), purged: await purgeExpiredMasked(deps) });
}
