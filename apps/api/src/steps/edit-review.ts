// 위키 수정본 수정분 검수 (사용자 결정 11/17 규칙 2, interfaces 6.2). 이전 버전과 문장 비교 →
// 바뀐 문장만 규정 대조 결과를 남기고, 지운 문장 중 한도·승인권자·금지 같은 중요 문장을 '고칠 것'으로 알린다.
import { newId, type Finding } from '../contracts.ts';

const squash = (s: string) => s.replace(/\s+/g, '').replace(/[#*>|`_-]/g, '');
/** 문장 단위 (줄 또는 마침표 뒤). 6자 미만은 제목·번호로 보고 뺀다 */
export const sentences = (text: string) =>
  text.split(/\n+|(?<=[.!?。])\s+/u).map((s) => s.replace(/^\s*(?:#{1,6}|[-*]|\d+[.)])\s*/u, '').trim()).filter((s) => squash(s).length >= 6);

const KEY = /한도|승인|금지|반드시|하여야|해야\s*한다|이상|이하|초과|미만|\d+\s*(?:원|만원|억원|%|분|시간|일|개월|년|회|영업일)/u;

export function editReview(before: string, after: string) {
  const prev = sentences(before), now = sentences(after);
  const ps = new Set(prev.map(squash)), ns = new Set(now.map(squash));
  const changed = now.filter((s) => !ps.has(squash(s)));
  const removed = prev.filter((s) => !ns.has(squash(s)));
  const key = removed.filter((s) => KEY.test(s)).slice(0, 5);
  const findings: Finding[] = key.map((s) => ({
    finding_id: newId.fnd(), step: 'TRUST_GATE', severity: 'MEDIUM', code: 'EDIT_REMOVED_KEY_SENTENCE',
    message: '수정에서 중요 문장(한도·승인·금지 등) 삭제', evidence_ref: 'edit-diff',
    location: { excerpt: s.slice(0, 160) },
    user_message: `수정하면서 중요한 문장이 빠졌습니다: "${s.slice(0, 80)}${s.length > 80 ? '…' : ''}"`,
    fix_hint: '실수로 지웠다면 되돌려 주세요. 일부러 지운 것이면 "의도한 삭제"를 눌러 확인하세요.',
  }));
  /** 노하우 판정 Finding 중 바뀐 문장에 대한 것만 남긴다 (바뀌지 않은 문장은 이전 버전에서 이미 승인됨) */
  const onChanged = (f: Finding) => !f.location?.excerpt || changed.some((s) => squash(s).includes(squash(f.location!.excerpt!).slice(0, 30)) || squash(f.location!.excerpt!).includes(squash(s).slice(0, 30)));
  return { changed, removed, findings, onChanged };
}
