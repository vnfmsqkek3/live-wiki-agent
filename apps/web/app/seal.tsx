import { Icon } from './icons';
import type { SearchItem } from './lib/api';

/** 결재란과 도장 (impeccable 방향 '결재란과 도장'). 모든 문서는 작성·AI 검사·승인 세 칸을 갖고,
 *  승인 칸에 그린 도장이 찍혀야 '검증 완료'다. 코랄 도장은 충돌·차단·반려, 점선 빈 도장은 대기.
 *  한 화면의 모든 신뢰 표시는 이 부품 하나로만 그린다 (카드는 mini, 상세·결재는 full). */
type Doc = { authority_status: string; document_type?: string; lifecycle?: string; freshness?: SearchItem['freshness']; mark_count?: number };
type Stamp = { label: string; tone: 'ok' | 'bad' | 'wait'; mark: string; hint: string };

export function kyulStamps(d: Doc, approvedNow = false): Stamp[] {
  const reg = d.document_type === 'REGULATION';
  const lc = d.lifecycle ?? 'PUBLISHED';
  const write: Stamp = { label: '작성', tone: 'ok', mark: reg ? '원본' : '등록', hint: reg ? '공식 규정 원본 등록' : '작성자 등록' };
  const check: Stamp =
    lc === 'QUARANTINED' ? { label: 'AI 검사', tone: 'wait', mark: '검사중', hint: '자동 검사 진행 중' }
    : lc === 'BLOCKED' ? { label: 'AI 검사', tone: 'bad', mark: '차단', hint: '보안 검사에서 차단' }
    : (d.mark_count ?? 0) > 0 || d.freshness === 'REVIEW_REQUIRED' ? { label: 'AI 검사', tone: 'bad', mark: '확인', hint: '고칠 곳이나 재검토 사유가 있음' }
    : d.mark_count === undefined && lc !== 'PUBLISHED' ? { label: 'AI 검사', tone: 'ok', mark: '완료', hint: '자동 검사 완료' }
    : { label: 'AI 검사', tone: 'ok', mark: '통과', hint: '자동 검사 통과' };
  const verified = approvedNow || (d.authority_status === 'VERIFIED' && lc === 'PUBLISHED');
  const approve: Stamp =
    verified ? { label: '승인', tone: 'ok', mark: reg ? '공식' : '승인', hint: reg ? '공식 원본과 일치' : '사람이 승인' }
    : d.authority_status === 'REJECTED' || lc === 'BLOCKED' ? { label: '승인', tone: 'bad', mark: lc === 'BLOCKED' ? '불가' : '반려', hint: lc === 'BLOCKED' ? '차단되어 승인할 수 없음' : '승인자가 반려' }
    : { label: '승인', tone: 'wait', mark: lc === 'PENDING_APPROVAL' ? '대기' : '검토중', hint: lc === 'PENDING_APPROVAL' ? '승인자 결재 대기' : '작성자 검토 중' };
  return [write, check, approve];
}

/** 화면 읽기용 한 줄: 점검 스크립트(D8)도 이 문구로 확인한다 */
export function sealLabel(d: Doc) {
  return d.authority_status !== 'VERIFIED' ? '미검증 문서'
    : d.document_type === 'REGULATION' ? '공식 규정 원본과 일치'
    : d.document_type === 'MANUAL' ? '사람 승인으로 검증 완료' : '근거 규정 확인 후 사람 승인으로 검증 완료';
}

/** 목록용 한 줄 상태: 세 칸 중 가장 먼저 봐야 할 칸 하나(문제 → 대기 → 승인 순) + 글자 라벨 (Fable 검토 11/18: 작은 도장 3개는 라벨 없이 읽히지 않음) */
export function summaryStamp(d: Doc): Stamp & { text: string } {
  const [, check, approve] = kyulStamps(d);
  const reg = d.document_type === 'REGULATION';
  if (check!.tone === 'bad') return { ...check!, text: check!.mark === '차단' ? '차단됨' : '고칠 곳 있음' };
  if (approve!.tone === 'bad') return { ...approve!, text: approve!.mark === '반려' ? '반려됨' : '차단됨' };
  if (check!.tone === 'wait') return { ...check!, text: 'AI 검사 중' };
  if (approve!.tone === 'wait') return { ...approve!, text: approve!.mark === '대기' ? '승인 대기' : '작성자 검토 중' };
  return { ...approve!, text: reg ? '공식 규정' : '검증 완료' };
}

/** 결재란. size=mini는 목록용(도장 1개 + 글자), full은 상세·결재용(3칸, 칸 아래 일자·승인자).
 *  aria-label 은 QA(D8)가 읽으므로 sealLabel 문장을 앞에 둔다 */
export function Seal({ i, size = 'mini', stampedNow = false, who }: { i: Doc; size?: 'mini' | 'full'; stampedNow?: boolean; stamp?: boolean;
  who?: { written_at?: string; checked_at?: string | null; approver?: string | null; approved_at?: string | null } }) {
  const stamps = kyulStamps(i, stampedNow);
  const label = `${sealLabel(i)} · ${stamps.map((s) => `${s.label} ${s.hint}`).join(', ')}`;
  if (size === 'mini') {
    const one = summaryStamp(i);
    return (
      <span className={`seal kyul mini one tone-${one.tone}`} role="img" aria-label={label}>
        <i className={`stamp ${one.tone}`} aria-hidden="true">{one.mark}</i><span className="seal-text">{one.text}</span>
      </span>
    );
  }
  const day = (x?: string | null) => (x ? new Date(x).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(5) : '');
  const under = [day(who?.written_at), day(who?.checked_at), [who?.approver, day(who?.approved_at)].filter(Boolean).join(' ')];
  return (
    <span className={`seal kyul ${size}`} role="img" aria-label={label}>
      {stamps.map((s, n) => (
        <span key={s.label} className="kyul-cell">
          <small>{s.label}</small>
          <i className={`stamp ${s.tone}${stampedNow && n === 2 ? ' now' : ''}`} title={`${s.label}: ${s.hint}`}>{s.mark}</i>
          {who && <span className="kyul-who">{under[n] || '\u00a0'}</span>}
        </span>
      ))}
    </span>
  );
}

export function FreshnessFlag({ freshness }: { freshness: SearchItem['freshness'] }) {
  if (freshness === 'SUPERSEDED') return <span className="flag"><Icon name="alert" />개정·폐지되어 현행이 아닌 판</span>;
  return freshness === 'REVIEW_REQUIRED' ? <span className="flag"><Icon name="alert" />근거 규정이 바뀌어 재검토 중</span> : null;
}
