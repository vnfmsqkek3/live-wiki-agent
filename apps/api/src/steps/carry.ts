// 위키 수정 후 재분석에서 이전 결정을 잇는다 (사용자 지적 11/18: 고치고 저장할 때마다 AI 검사가 새 항목을 늘리고, '해당 없음'·'그대로 사용'이 사라졌다).
// - 같은 항목(코드+원문 문장)에 내린 '해당 없음'·'그대로 사용'은 그대로 둔다
// - '확인 필요'는 이번에 고친 줄에서만 새로 묻는다. 고치지 않은 줄은 이미 한 번 검토했으므로 새 질문을 만들지 않는다(전에 열려 있던 것은 남김)
// - 개인정보·비밀값 등 다른 항목은 지우지 않고 결정만 잇는다
// - 규정 충돌(KNOWHOW_CONFLICT)이 고치지 않은 문장에서 새로 나오면 올린 사람을 막지 않고 승인자에게만 보인다 (사용자 결정 11/18)
import { createHash } from 'node:crypto';
import type { Finding } from '../contracts.ts';

export interface ReviewCarry { text: string; /** 이전 검사에서 규정 비교(노하우 검증)를 했는가. 안 했으면 처음 나온 충돌은 올린 사람이 처리 */ validated?: boolean; items: { code: string; key: string; status: 'OPEN' | 'DISMISSED' | 'ACK'; reason?: string; by?: string; at?: string }[] }
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const h = (s: string) => createHash('sha256').update(norm(s)).digest('hex').slice(0, 16);
const textOf = (f: Finding) => String((f.details as { before?: unknown } | undefined)?.before ?? f.location?.excerpt ?? f.message);
const keyOf = (f: Finding) => h(`${f.code}|${textOf(f)}`);

export function makeCarry(oldText: string, findings: Finding[], validated = false): ReviewCarry {
  return {
    validated,
    text: norm(oldText).slice(0, 300_000), // 문장이 한 줄 안에 있을 수 있어 해시가 아닌 글로 (정리본 마스킹 글)
    items: findings.flatMap((f): ReviewCarry['items'] => {
      const st = (f.details as { status?: string; dismiss_reason?: string } | undefined)?.status;
      if (f.code === 'CLARIFY_NEEDED' && st === 'DISMISSED') return [{ code: f.code, key: keyOf(f), status: 'DISMISSED' as const, reason: (f.details as { dismiss_reason?: string }).dismiss_reason ?? f.acknowledged?.reason, by: f.acknowledged?.by, at: f.acknowledged?.at }];
      // 시스템이 붙인 '승인자 판단'(system:recheck)은 사람 결정이 아니라 잇지 않는다 → 다음 재검사에서 다시 판단 (11/18 prod H5)
      if (f.acknowledged && !f.acknowledged.by.startsWith('system:')) return [{ code: f.code, key: keyOf(f), status: 'ACK' as const, reason: f.acknowledged.reason, by: f.acknowledged.by, at: f.acknowledged.at }];
      if ((f.code === 'CLARIFY_NEEDED' && st === 'OPEN') || f.code === 'KNOWHOW_CONFLICT') return [{ code: f.code, key: keyOf(f), status: 'OPEN' as const }];
      return [];
    }),
  };
}

export function applyCarry(c: ReviewCarry | undefined, findings: Finding[]): Finding[] {
  if (!c) return findings;
  const byKey = new Map(c.items.map((x) => [`${x.code}|${x.key}`, x]));
  return findings.flatMap((f) => {
    const prev = byKey.get(`${f.code}|${keyOf(f)}`);
    const ack = prev?.by && prev.at ? { by: prev.by, at: prev.at, ...(prev.reason ? { reason: prev.reason } : {}) } : undefined;
    if (f.code === 'CLARIFY_NEEDED') {
      if (prev?.status === 'DISMISSED') return [{ ...f, ...(ack ? { acknowledged: ack } : {}), details: { ...f.details, status: 'DISMISSED', dismiss_reason: prev.reason ?? '' } }];
      if (prev?.status === 'OPEN') return [f];
      const t = norm(textOf(f));
      return t && c.text.includes(t) ? [] : [f]; // 고치지 않은 문장의 새 질문은 만들지 않는다
    }
    if (prev?.status === 'ACK' && ack && !f.acknowledged) return [{ ...f, acknowledged: ack }];
    // 규정 충돌: 고치지 않은 문장에서 재검사로 새로 나온 것은 올린 사람을 막지 않고 승인자에게 보인다 (사용자 결정 11/18, 규칙 2 완화)
    // 전에 규정 비교를 한 문서의 재검사에서만 (종류를 매뉴얼→노하우로 바꾼 첫 비교의 충돌은 올린 사람이 처리, 11/18 prod H5)
    if (f.code === 'KNOWHOW_CONFLICT' && c.validated && !prev && !f.acknowledged && c.text.includes(norm(textOf(f))))
      return [{ ...f, acknowledged: { by: 'system:recheck', at: new Date().toISOString(), reason: '재검사에서 새로 나옴(고치지 않은 문장) — 승인자 판단' } }];
    return [f];
  });
}
