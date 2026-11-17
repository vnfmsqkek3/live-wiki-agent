// 단계 7 InjectionScan. 입력은 마스킹된 텍스트. 문서 텍스트는 untrusted.
import { excerptAround, newId, type Finding, type StepOutput } from '../contracts.ts';

// ponytail: 규칙 기반 1차 필터. LLM 판정은 11/19 Guardrails prompt-attack 필터와 함께 추가
export const INJECTION_RULES: { re: RegExp; code: string; severity: 'HIGH' | 'MEDIUM' }[] = [
  { re: /ignore\s+(all\s+|any\s+)?(previous|prior|above)\s+(instructions|rules|prompts)/i, code: 'OVERRIDE_EN', severity: 'HIGH' },
  { re: /(이전|앞의|위의|기존)\s*(의\s*)?(모든\s*)?(지시|지침|명령|규칙|프롬프트)[을를은는]?\s*(모두\s*)?(무시|잊)/, code: 'OVERRIDE_KO', severity: 'HIGH' },
  { re: /(system\s*prompt|시스템\s*프롬프트)[를을]?\s*(출력|공개|보여|reveal|print)/i, code: 'PROMPT_LEAK', severity: 'HIGH' },
  { re: /(you\s+are\s+now|너는\s*이제|지금부터\s*(너는|당신은))/i, code: 'ROLE_HIJACK', severity: 'HIGH' },
  { re: /(답변|응답|대답)[을를]?\s*(항상|반드시|무조건)?\s*[^.\n]{0,30}(바꿔|변경하|으로\s*답하|라고\s*답하)/, code: 'ANSWER_STEERING', severity: 'HIGH' },
  { re: /(AI|모델|어시스턴트|assistant|LLM)(에게|는|은)?\s*[^.\n]{0,20}(지시|명령|instruction)/i, code: 'MODEL_ADDRESSED', severity: 'MEDIUM' },
  { re: /^\s*(system|assistant)\s*:|<\/?(system|instructions?)>|###\s*instruction/im, code: 'ROLE_MARKER', severity: 'MEDIUM' },
  { re: /[\u200B-\u200D\u2060\uFEFF\u202A-\u202E]/, code: 'HIDDEN_UNICODE', severity: 'MEDIUM' },
];

export function injectionScan(segments: { page: number; text: string }[]): StepOutput {
  const findings: Finding[] = [];
  for (const s of segments)
    for (const r of INJECTION_RULES) {
      const m = new RegExp(r.re.source, r.re.flags.replace('g', '')).exec(s.text);
      if (!m) continue;
      // 마스킹본만 받으므로 excerpt에 개인 식별값은 없다
      findings.push({ finding_id: newId.fnd(), step: 'INJECTION_SCAN', severity: r.severity, code: r.code, message: `프롬프트 인젝션 의심 패턴 ${r.code}`, evidence_ref: `page:${s.page}`,
        location: { page: s.page + 1, excerpt: excerptAround(s.text, m.index, m.index + m[0].length) },
        user_message: `${s.page + 1}쪽에 AI에게 지시하는 형태의 문장("${m[0].slice(0, 40)}")이 있습니다.${r.severity === 'HIGH' ? ' 보안상 등록할 수 없습니다.' : ' 관리자가 확인합니다.'}`,
        fix_hint: '해당 문장을 지우거나, 업무 설명으로 바꿔 쓴 뒤 다시 올려 주세요.' });
    }
  const status = findings.some((x) => x.severity === 'HIGH') ? 'BLOCKED' : findings.length ? 'REVIEW_REQUIRED' : 'OK';
  return { status, findings };
}
