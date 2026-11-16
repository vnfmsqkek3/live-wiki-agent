// 단계 6 PiiScan. ① 정규식·체크섬·사전 → ② Guardrails ApplyGuardrail(마스킹된 텍스트) → 마스킹.
// 불확실 구간이 남으면 REVIEW_REQUIRED. 원문은 모델에 보내지 않는다. Finding에 원문을 넣지 않는다.
import { newId, type Finding, type StepOutput } from '../contracts.ts';

import { PII_NAME, detectPii, mask } from './pii-detect.ts';
export { detectPii, mask, rrnChecksumOk, luhnOk, type PiiSpan, type PiiType } from './pii-detect.ts';

/** ApplyGuardrail 결과: 추가로 탐지된 유형 수와 마스킹된 텍스트. GUARDRAIL_ID 없으면 undefined. */
export type GuardrailCheck = (maskedText: string) => Promise<{ text: string; detected: number } | undefined>;

export async function piiScan(
  segments: { page: number; text: string }[],
  guardrail?: GuardrailCheck,
): Promise<StepOutput & { masked: { page: number; text: string }[] }> {
  const findings: Finding[] = [];
  const masked: { page: number; text: string }[] = [];
  let guardrailSkipped = false;
  for (const s of segments) {
    const spans = detectPii(s.text);
    let text = mask(s.text, spans);
    for (const t of new Set(spans.map((x) => x.type))) {
      const n = spans.filter((x) => x.type === t);
      const uncertain = n.filter((x) => !x.certain).length;
      findings.push(fnd(uncertain ? 'MEDIUM' : 'LOW', uncertain ? `PII_UNCERTAIN_${t}` : `PII_MASKED_${t}`,
        `${PII_NAME[t]} ${n.length}건 가림${uncertain ? ` (그중 ${uncertain}건은 개인정보인지 확인 필요)` : ''}`, `page:${s.page}`));
    }
    const g = guardrail ? await guardrail(text) : undefined;
    if (!g) guardrailSkipped = true;
    else if (g.detected > 0) {
      text = g.text;
      findings.push(fnd('MEDIUM', 'PII_GUARDRAIL', `추가 검사에서 개인정보 의심 ${g.detected}건 발견, 확인 필요`, `page:${s.page}`));
    }
    masked.push({ page: s.page, text });
  }
  if (guardrailSkipped)
    findings.push(fnd('LOW', 'GUARDRAIL_SKIPPED', 'Guardrails 미설정 → 정규식 단계만 수행', 'config'));
  const status = findings.some((x) => x.severity === 'MEDIUM' || x.severity === 'HIGH') ? 'REVIEW_REQUIRED' : 'OK';
  return { status, findings, masked };
}

function fnd(severity: Finding['severity'], code: string, message: string, evidence_ref: string): Finding {
  return { finding_id: newId.fnd(), step: 'PII_SCAN', severity, code, message, evidence_ref };
}
