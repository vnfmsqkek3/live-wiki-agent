// approval MCP (Gateway Lambda Target, Owner dhxorb96). Tool: create_review_request, get_status, draft_change
// 승인·게시 실행 Tool은 없다 (docs/05 4장). 사람 승인은 Backend API만. 신원은 interceptor가 주입한 __actor만 신뢰.
import { newId } from '../../../apps/api/src/contracts.ts';
import { ApiError } from '../../../apps/api/src/errors.ts';
import { detectPii, mask } from '../../../apps/api/src/steps/pii-detect.ts';
import type { Store } from '../../../apps/api/src/store.ts';
import { submitForApproval } from '../../../apps/api/src/submit.ts';

type Actor = { sub: string; groups: string[] };
type Event = Record<string, unknown> & { __actor?: Partial<Actor> };
type Ctx = { clientContext?: { custom?: { bedrockAgentCoreToolName?: string } } };

const ROLES: Record<string, string[]> = {
  create_review_request: ['AUTHOR'],
  get_status: ['AUTHOR', 'REG_APPROVER', 'SECURITY_REVIEWER'],
  draft_change: ['AUTHOR', 'REG_APPROVER'],
};
const REVIEWERS = ['REG_APPROVER', 'SECURITY_REVIEWER'];
const DOC_ID = /^doc_[0-9A-HJKMNP-TV-Z]{26}$/;

export function makeHandler(store: Store) {
  return async (event: Event, ctx: Ctx) => {
    const tool = (ctx.clientContext?.custom?.bedrockAgentCoreToolName ?? '').split('___').pop() ?? '';
    const a = event.__actor;
    const trace = newId.fnd().replace('fnd_', 'mcp_');
    const audit = (result: 'OK' | 'DENIED', resource: string) =>
      store.audit({ at: new Date().toISOString(), actor: a?.sub ?? 'unknown', action: `MCP_${tool}`, resource, result, trace_id: trace });
    const fail = async (code: string, message: string, resource = '-') => { if (code === 'FORBIDDEN') await audit('DENIED', resource); return { error: { code, message } }; };

    if (!a?.sub || !Array.isArray(a.groups)) return fail('FORBIDDEN', '신원 정보가 없습니다');
    const actor = a as Actor;
    if (!ROLES[tool]) return fail('FORBIDDEN', `${tool || 'unknown'}: 이 Tool은 제공하지 않습니다. 승인·게시는 담당자가 결재 화면에서 합니다`);
    if (!actor.groups.some((g) => ROLES[tool]!.includes(g))) return fail('FORBIDDEN', '이 Tool을 쓸 권한이 없습니다');
    const doc_id = String(event.doc_id ?? '');
    if (!DOC_ID.test(doc_id)) return fail('VALIDATION', 'doc_id 형식이 아닙니다');
    const d = await store.getDoc(doc_id);
    const visible = d && (d.owner === actor.sub || actor.groups.some((g) => REVIEWERS.includes(g)) || d.lifecycle === 'PUBLISHED');
    if (!d || !visible) return fail('NOT_FOUND', '문서를 찾을 수 없습니다');

    try {
      switch (tool) {
        case 'get_status':
          await audit('OK', doc_id);
          return { doc_id, lifecycle: d.lifecycle, trust_gate_result: d.trust_gate_result ?? null, authority_status: d.authority_status, freshness: d.freshness, version: d.version };
        case 'create_review_request': {
          const apr = await submitForApproval(store, d, actor.sub);
          await audit('OK', doc_id);
          return { approval_id: apr.approval_id, status: apr.status, message: '게시 요청을 만들었습니다. 규정 승인자가 결재해야 게시됩니다.' };
        }
        case 'draft_change': {
          const text = typeof event.proposed_text === 'string' ? event.proposed_text : '';
          const basis = Array.isArray(event.basis) ? event.basis.filter((b): b is string => typeof b === 'string' && b.length <= 200).slice(0, 20) : [];
          if (!text || text.length > 10_000) return fail('VALIDATION', 'proposed_text: 1~10000자');
          if (!basis.length) return fail('VALIDATION', 'basis: 근거 조문·문서를 1개 이상 적어야 합니다');
          if (d.lifecycle !== 'PUBLISHED') return fail('CONFLICT', '게시된 문서만 수정 초안을 만들 수 있습니다');
          const draft_id = newId.draft();
          await store.putDraft({ draft_id, doc_id, base_version: d.version, proposed_text: mask(text, detectPii(text)), basis, created_by: actor.sub, status: 'DRAFT', created_at: new Date().toISOString() });
          await audit('OK', doc_id);
          return { draft_id, status: 'DRAFT', message: '수정 초안을 저장했습니다. 자동 게시되지 않으며 담당자 재승인이 필요합니다.' };
        }
      }
    } catch (e) {
      if (e instanceof ApiError) return fail(e.code, e.message, doc_id);
      throw e;
    }
    return fail('NOT_FOUND', 'unknown tool');
  };
}
