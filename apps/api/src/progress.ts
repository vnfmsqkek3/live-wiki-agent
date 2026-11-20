// 업로드 진행바 (사용자 확인 13항 8번): 오케스트레이터 1차 실행 단계 순서와 WORKFLOWS 기록으로 진행률을 만든다
export const INGEST_STEPS = [
  ['MalwareCheck', '악성코드 검사'], ['FileStructureCheck', '파일 구조 검사'], ['ConvertToPdf', '문서 변환'], ['TextLayerExtract', '텍스트 추출'], ['PageRender', '페이지 이미지'],
  ['OcrIfNeeded', '문자 인식'], ['SegmentBuild', '본문 정리'], ['PiiScan', '개인정보 가림'], ['ImageDescribe', '그림 분석'], ['InjectionScan', '지시문 검사'], ['PageSummarize', '쪽 요약'],
  ['Classify', '분류·요약'], ['ReferenceCheck', '참조 확인'], ['TrustGate', '출처·근거 검증'], ['ExplainFindings', '확인 결과 설명'], ['WaitForApproval', '검토 준비'],
] as const;
export type StepState = 'done' | 'running' | 'pending' | 'failed' | 'blocked' | 'skipped';

export function progress(lifecycle: string, rec: { step: string; status: string; error?: string }[]) {
  const by = new Map(rec.map((r) => [r.step, r]));
  const halted = lifecycle === 'BLOCKED' || rec.some((r) => r.status === 'FAILED');
  const finished = lifecycle !== 'QUARANTINED';
  // 마지막으로 기록된 단계보다 앞인데 기록이 없으면 이 문서에서 건너뛴 단계 (예: 그림 없음, 그림 분석 꺼짐)
  const last = Math.max(-1, ...INGEST_STEPS.map(([k], i) => (by.has(k) ? i : -1)));
  const steps = INGEST_STEPS.map(([key, label], i) => {
    const r = by.get(key);
    let state: StepState = 'pending';
    if (r?.status === 'FAILED') state = 'failed';
    else if (r?.status === 'BLOCKED') state = 'blocked';
    else if (r) state = 'done';
    else if (i < last || finished) state = 'skipped';
    else if (i === last + 1 && !halted) state = 'running';
    return { key, label, state };
  });
  const counted = steps.filter((s) => s.state !== 'skipped');
  const done = counted.filter((s) => s.state === 'done').length;
  return { lifecycle, total: counted.length, done: finished && !halted ? counted.length : done, finished, halted, steps: steps.filter((s) => s.state !== 'skipped' || !finished) };
}

/** 차단 사유를 사용자 문장으로 (HIGH Finding만). 원문·탐지값은 넣지 않는다 */
const REASON: Record<string, string> = {
  PDF_EMBEDDED_FILE: '첨부 파일이 포함된 PDF는 보안상 등록할 수 없습니다. 첨부를 뺀 PDF로 다시 올려 주세요.',
  PDF_JAVASCRIPT: '스크립트가 들어 있는 PDF는 등록할 수 없습니다.',
  PDF_LAUNCH: '다른 프로그램을 실행하는 동작이 들어 있는 PDF는 등록할 수 없습니다.',
  OFFICE_MACRO: '매크로·ActiveX가 들어 있는 문서는 등록할 수 없습니다. 매크로를 뺀 파일로 다시 올려 주세요.',
  ZIP_BOMB: '압축을 풀면 지나치게 커지는 파일이라 등록할 수 없습니다.',
  ZIP_INVALID: '파일 구조가 손상되어 열 수 없습니다.',
  TRAILING_DATA: '파일 끝에 숨은 데이터가 있어 등록할 수 없습니다.',
  PNG_METADATA_INJECTION: '이미지 정보(메타데이터)에 AI에게 지시하는 문구가 있어 등록할 수 없습니다.',
  JPG_METADATA_INJECTION: '이미지 정보(메타데이터)에 AI에게 지시하는 문구가 있어 등록할 수 없습니다.',
  EXT_MISMATCH: '파일 내용이 확장자와 다릅니다. 원래 형식의 파일로 올려 주세요.',
  UNSUPPORTED_TYPE: '지원하지 않는 파일 형식입니다. PDF, DOCX, HWPX, PNG, JPG만 올릴 수 있습니다.',
  SECURITY_POLICY: '보안 검사에서 위험 요소가 발견되어 격리했습니다.',
};
/** 화면용 문장: 단계가 만든 user_message → 코드별 안내 → 기본 문장. 내부 message(바이트·조문 ID·코드)는 화면에 내지 않는다 (사용자 지적 11/17) */
export function plainMessage(f: { severity: string; code: string; step: string; user_message?: string }) {
  return f.user_message ?? REASON[f.code] ?? (f.step === 'INJECTION_SCAN' ? 'AI에게 지시하는 형태의 문장이 들어 있습니다.' : f.severity === 'HIGH' ? '보안 검사에서 위험 요소가 발견되었습니다.' : '자동 검사에서 확인이 필요한 내용이 발견되었습니다.');
}

export function blockedReasons(findings: { severity: string; code: string; step: string }[]) {
  const high = findings.filter((f) => f.severity === 'HIGH');
  const out = high.map((f) => REASON[f.code] ?? (f.step === 'INJECTION_SCAN' ? 'AI에게 지시하는 문구가 들어 있어 등록할 수 없습니다. 해당 문구를 지우고 다시 올려 주세요.'
    : f.step === 'TYPE_DETECTION' ? '파일 형식이 확장자와 다르거나 지원하지 않는 형식입니다.' : f.step === 'MALWARE' ? '악성코드 검사에서 위험이 발견되었습니다.' : '보안 검사에서 위험 요소가 발견되었습니다.'));
  return [...new Set(out)];
}

const STEP_LABEL: Record<string, string> = Object.fromEntries([...INGEST_STEPS, ['Promote', '게시'], ['KbIngest', '검색 색인'], ['GraphUpsert', '관계 그래프'], ['Finalize', '마무리'],
  ['TYPE_DETECTION', '형식 확인'], ['MALWARE', '악성코드 검사'], ['FILE_STRUCTURE', '파일 구조 검사'], ['OCR', '문자 인식'], ['PII_SCAN', '개인정보 가림'], ['INJECTION_SCAN', '지시문 검사'],
  ['CLASSIFY', '분류·요약'], ['TRUST_GATE', '출처·근거 검증'], ['KNOWHOW_VALIDATION', '근거 대조'], ['EXTERNAL_LAW_CHECK', '외부 법령 대조'], ['IMAGE_DESCRIBE', '그림 분석'], ['TEXT_LAYER', '텍스트 추출'], ['SEGMENT', '본문 정리']]);

export interface Issue { finding_id?: string; step: string; step_label: string; severity: string; code: string; user_message: string; fix_hint?: string; location?: { page?: number; bbox?: number[][]; excerpt?: string } }

/** 올린 사람용 사유 목록: 단계 Finding(위치·안내) + 실행 실패(게시 실패 포함). 심각도·쪽 순 */
export function issues(findings: { finding_id?: string; step: string; severity: string; code: string; message: string; user_message?: string; fix_hint?: string; location?: Issue['location'] }[],
  failure?: { step: string; error: string; message?: string }): Issue[] {
  const out: Issue[] = findings.map((f) => ({
    ...(f.finding_id ? { finding_id: f.finding_id } : {}), step: f.step, step_label: STEP_LABEL[f.step] ?? f.step, severity: f.severity, code: f.code,
    user_message: plainMessage(f), ...(f.fix_hint ? { fix_hint: f.fix_hint } : {}), ...(f.location ? { location: f.location } : {}),
  }));
  if (failure) {
    const publish = ['Promote', 'KbIngest', 'GraphUpsert', 'Finalize'].includes(failure.step);
    // let522mj 예외 문장은 '사유 (조치: …)' 형식 → 사유·조치로 나눈다
    const m = failure.message ? /^(.*?)\s*\(조치:\s*(.*)\)\s*$/.exec(failure.message) : null;
    out.unshift({
      step: failure.step, step_label: STEP_LABEL[failure.step] ?? failure.step, severity: 'HIGH', code: failure.error,
      user_message: m?.[1] ?? failure.message ?? `${STEP_LABEL[failure.step] ?? '처리'} 단계에서 처리가 멈췄습니다.`,
      fix_hint: m?.[2] ?? (publish ? '승인은 유지됩니다. 운영 담당자가 원인을 확인한 뒤 다시 게시합니다.' : '파일을 확인해 다시 올려 주세요. 계속 실패하면 운영 담당자에게 문의하세요.'),
    });
  }
  const rank: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return out.sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3) || (a.location?.page ?? 1e9) - (b.location?.page ?? 1e9));
}
