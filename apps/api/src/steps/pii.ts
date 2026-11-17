// 단계 6 PiiScan. ① 규칙(@hanaeum/pii: 식별값만, 사용자 결정 11/17)이 마스킹을 정한다
// ② Guardrails는 보조: 비밀값(비밀번호·키·PIN·CVV)만 그 부분을 가리고, 나머지 탐지는 원문을 덮어쓰지 않고 사람 확인 Finding.
//    (Guardrail이 "이 규정은"→"이 {NAME}은"처럼 공식 조문을 훼손한 사례, let522mj 11/17)
// 불확실 구간이 남으면 REVIEW_REQUIRED. Finding에 탐지 원문을 넣지 않는다.
import { excerptAround, newId, type Finding, type StepOutput } from '../contracts.ts';

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
      const at = text.indexOf(`[${PII_NAME[t]}]`);
      findings.push(fnd(uncertain ? 'MEDIUM' : 'LOW', uncertain ? `PII_UNCERTAIN_${t}` : `PII_MASKED_${t}`,
        `${PII_NAME[t]} ${n.length}건 가림${uncertain ? ` (그중 ${uncertain}건은 개인정보인지 확인 필요)` : ''}`, `page:${s.page}`, {
          location: { page: s.page + 1, ...(at >= 0 ? { excerpt: excerptAround(text, at, at + PII_NAME[t].length + 2) } : {}) },
          user_message: `${s.page + 1}쪽에서 ${PII_NAME[t]} ${n.length}건을 가렸습니다${uncertain ? `. 그중 ${uncertain}건은 실제 ${PII_NAME[t]}인지 확인이 필요합니다` : ''}.`,
          ...(uncertain ? { fix_hint: `${PII_NAME[t]}가 아니라면(예: 문서번호·참조번호) 검토 화면에서 확인해 주세요. 실제 ${PII_NAME[t]}라면 지우고 다시 올리는 것을 권장합니다.` } : {}),
        }));
    }
    const g = guardrail ? await guardrail(text) : undefined;
    if (!g) guardrailSkipped = true;
    else {
      const ents = g.entities ?? [];
      for (const e of ents.filter((x) => SECRET_TYPES.has(x.type))) text = text.split(e.match).join('[비밀값]');
      const secrets = ents.filter((x) => SECRET_TYPES.has(x.type)).length;
      // IP는 규칙이 '[IP 주소]'로 가리고, 사용자명은 장비·제조사 이름 오탐이 많아 확인 항목에서 뺀다 (사용자 결정 11/17)
      const other = ents.filter((x) => !SECRET_TYPES.has(x.type) && !GUARD_SKIP.has(x.type));
      if (secrets) {
        const at = text.indexOf('[비밀값]');
        findings.push(fnd('MEDIUM', 'SECRET_MASKED', `비밀값(비밀번호·키 등) ${secrets}건 가림`, `page:${s.page}`, {
          location: { page: s.page + 1, ...(at >= 0 ? { excerpt: excerptAround(text, at, at + 5) } : {}) },
          user_message: `${s.page + 1}쪽에 비밀번호·접근 키 같은 비밀값 ${secrets}건이 있어 가렸습니다.`,
          fix_hint: '문서에서 비밀값을 지우고 다시 올려 주세요. 이미 노출된 비밀번호·키는 바꾸는 것이 안전합니다.',
        }));
      }
      if (other.length) {
        const kinds = [...new Set(other.map((x) => GUARD_NAME[x.type] ?? x.type))].join(', ');
        findings.push(fnd('MEDIUM', 'PII_GUARDRAIL', `추가 검사에서 개인정보 의심 ${other.length}건(${kinds}) — 원문 유지, 사람 확인`, `page:${s.page}`, {
          location: { page: s.page + 1 }, // 탐지 값은 마스킹 전 값일 수 있어 excerpt에 넣지 않는다
          user_message: `${s.page + 1}쪽에 ${kinds}로 보이는 값이 ${other.length}건 있습니다. 원문은 그대로 두었습니다.`,
          fix_hint: '개인을 식별하는 값이면 지우고 다시 올려 주세요. 대표번호·공용 주소처럼 개인정보가 아니면 그대로 두면 됩니다.',
        }));
      }
    }
    masked.push({ page: s.page, text });
  }
  if (guardrailSkipped)
    findings.push(fnd('LOW', 'GUARDRAIL_SKIPPED', 'Guardrails 미설정 → 정규식 단계만 수행', 'config'));
  const status = findings.some((x) => x.severity === 'MEDIUM' || x.severity === 'HIGH') ? 'REVIEW_REQUIRED' : 'OK';
  return { status, findings, masked };
}

/** Guardrail 탐지 중 확인 항목·그림 칠하기에서 빼는 유형 (사용자 결정 11/17) */
export const GUARD_SKIP = new Set(['IP_ADDRESS', 'USERNAME']);
const GUARD_NAME: Record<string, string> = { PHONE: '전화번호', EMAIL: '이메일', CREDIT_DEBIT_CARD_NUMBER: '카드번호', IP_ADDRESS: 'IP 주소', LICENSE_PLATE: '차량번호', USERNAME: '사용자 ID' };

function fnd(severity: Finding['severity'], code: string, message: string, evidence_ref: string, extra: Pick<Finding, 'location' | 'user_message' | 'fix_hint'> = {}): Finding {
  return { finding_id: newId.fnd(), step: 'PII_SCAN', severity, code, message, evidence_ref, ...extra };
}
