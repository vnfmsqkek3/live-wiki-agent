// 단계 6 PiiScan. ① 규칙(@hanaeum/pii: 식별값만, 사용자 결정 11/17)이 마스킹을 정한다
// ② Guardrails는 보조: 비밀값(비밀번호·키·PIN·CVV)만 그 부분을 가리고, 나머지 탐지는 원문을 덮어쓰지 않고 사람 확인 Finding.
//    (Guardrail이 "이 규정은"→"이 {NAME}은"처럼 공식 조문을 훼손한 사례, let522mj 11/17)
// 불확실 구간이 남으면 REVIEW_REQUIRED. Finding에 탐지 원문을 넣지 않는다.
import { newId, type Finding, type StepOutput } from '../contracts.ts';

import { PII_NAME, detectPii, mask } from './pii-detect.ts';
export { detectPii, mask, rrnChecksumOk, luhnOk, type PiiSpan, type PiiType } from './pii-detect.ts';

/** ApplyGuardrail 결과: 추가로 탐지된 유형 수와 마스킹된 텍스트. GUARDRAIL_ID 없으면 undefined. */
export type GuardrailCheck = (maskedText: string) => Promise<{ text: string; detected: number; entities?: { type: string; match: string }[] } | undefined>;

/** 원문에서 가려도 조문 의미가 바뀌지 않는 비밀값 */
export const SECRET_TYPES = new Set(['PASSWORD', 'PIN', 'AWS_ACCESS_KEY', 'AWS_SECRET_KEY', 'CREDIT_DEBIT_CARD_CVV']);

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
    else {
      const ents = g.entities ?? [];
      for (const e of ents.filter((x) => SECRET_TYPES.has(x.type))) text = text.split(e.match).join('[비밀값]');
      const secrets = ents.filter((x) => SECRET_TYPES.has(x.type)).length;
      const other = ents.filter((x) => !SECRET_TYPES.has(x.type));
      if (secrets) findings.push(fnd('MEDIUM', 'SECRET_MASKED', `비밀값(비밀번호·키 등) ${secrets}건 가림`, `page:${s.page}`));
      if (other.length)
        findings.push(fnd('MEDIUM', 'PII_GUARDRAIL', `추가 검사에서 개인정보 의심 ${other.length}건(${[...new Set(other.map((x) => x.type))].join(', ')}) — 원문은 그대로 두었습니다. 개인정보면 수정 후 다시 올려 주세요`, `page:${s.page}`));
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
