// 업로드 진행바 (사용자 확인 13항 8번): 오케스트레이터 1차 실행 단계 순서와 WORKFLOWS 기록으로 진행률을 만든다
export const INGEST_STEPS = [
  ['MalwareCheck', '악성코드 검사'], ['FileStructureCheck', '파일 구조 검사'], ['TextLayerExtract', '텍스트 추출'], ['PageRender', '페이지 이미지'],
  ['OcrIfNeeded', '문자 인식'], ['SegmentBuild', '본문 정리'], ['PiiScan', '개인정보 가림'], ['ImageDescribe', '그림 분석'], ['InjectionScan', '지시문 검사'],
  ['Classify', '분류·요약'], ['TrustGate', '출처·근거 검증'], ['WaitForApproval', '검토 준비'],
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
