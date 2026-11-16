// privacy MCP (Gateway Lambda Target, Owner dhxorb96). Tool: detect_sensitive_data, masking_preview
// 허용 역할: AUTHOR, SECURITY_REVIEWER (docs/01 10.4). 신원은 interceptor가 주입한 __actor만 신뢰한다.
// 원본 전달 최소화: 응답에 탐지 원문을 넣지 않는다 (유형·위치·개수만).
import { PII_NAME, detectPii, mask } from '../../../apps/api/src/steps/pii-detect.ts';

const ALLOWED = ['AUTHOR', 'SECURITY_REVIEWER'];
const MAX = 20_000;

type Event = { text?: unknown; __actor?: { sub?: string; groups?: string[] } };
type Ctx = { clientContext?: { custom?: { bedrockAgentCoreToolName?: string } } };

export const toolName = (ctx: Ctx) => (ctx.clientContext?.custom?.bedrockAgentCoreToolName ?? '').split('___').pop() ?? '';
const err = (code: string, message: string) => ({ error: { code, message } });

export async function handler(event: Event, ctx: Ctx) {
  const actor = event.__actor;
  if (!actor?.sub || !actor.groups?.some((g) => ALLOWED.includes(g))) return err('FORBIDDEN', '작성자·보안 검토자만 사용할 수 있습니다');
  if (typeof event.text !== 'string' || !event.text || event.text.length > MAX) return err('VALIDATION', `text: 1~${MAX}자`);
  const spans = detectPii(event.text);
  switch (toolName(ctx)) {
    case 'detect_sensitive_data': {
      const by: Record<string, number> = {};
      for (const s of spans) by[PII_NAME[s.type]] = (by[PII_NAME[s.type]] ?? 0) + 1;
      return { total: spans.length, uncertain: spans.filter((s) => !s.certain).length, by_type: by, spans: spans.map(({ type, start, end, certain }) => ({ type, start, end, certain })) };
    }
    case 'masking_preview':
      return { masked_text: mask(event.text, spans), masked_count: spans.length, needs_review: spans.some((s) => !s.certain) };
    default:
      return err('NOT_FOUND', 'unknown tool');
  }
}
