import Link from 'next/link';
import { useId, type ReactNode } from 'react';
import { Icon } from './icons';
import { getSession, type FreshnessReason, type LibraryCard, type SearchItem } from './lib/api';
import { isAdmin } from './lib/roles';
import { readable } from './lib/readable';

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
    : lc === 'BLOCKED' && d.authority_status !== 'REJECTED' ? { label: 'AI 검사', tone: 'bad', mark: '차단', hint: '보안 검사에서 차단' }
    : (d.mark_count ?? 0) > 0 || d.freshness === 'REVIEW_REQUIRED' ? { label: 'AI 검사', tone: 'bad', mark: '확인', hint: '고칠 곳이나 재검토 사유가 있음' }
    : d.mark_count === undefined && lc !== 'PUBLISHED' ? { label: 'AI 검사', tone: 'ok', mark: '완료', hint: '자동 검사 완료' }
    : { label: 'AI 검사', tone: 'ok', mark: '통과', hint: '자동 검사 통과' };
  const verified = approvedNow || (d.authority_status === 'VERIFIED' && lc === 'PUBLISHED');
  const approve: Stamp =
    verified ? { label: '승인', tone: 'ok', mark: reg ? '공식' : '승인', hint: reg ? '공식 원본과 일치' : '사람이 승인' }
    : d.authority_status === 'REJECTED' ? { label: '승인', tone: 'bad', mark: '반려', hint: '승인자가 반려' } // 반려도 lifecycle은 BLOCKED (엔드유저 11/20)
    : lc === 'BLOCKED' ? { label: '승인', tone: 'bad', mark: '불가', hint: '차단되어 승인할 수 없음' }
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
  if (check!.tone === 'bad') return { ...check!, text: check!.mark === '차단' ? '차단됨' : d.freshness === 'REVIEW_REQUIRED' && !(d.mark_count ?? 0) ? '재검토 필요' : '고칠 곳 있음' };
  if (approve!.tone === 'bad') return { ...approve!, text: approve!.mark === '반려' ? '반려됨' : '차단됨' };
  if (check!.tone === 'wait') return { ...check!, text: 'AI 검사 중' };
  if (approve!.tone === 'wait') return { ...approve!, text: approve!.mark === '대기' ? '승인 대기' : '작성자 검토 중' };
  return { ...approve!, mark: '승인', text: reg ? '공식 규정' : '검증 완료' }; // 도장 '공식' + '공식 규정'이 '공식공식 규정'으로 읽힘 (엔드유저 11/20)
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
  const under = [day(who?.written_at), day(who?.checked_at), [who?.approver, day(who?.approved_at)].filter(Boolean).join('\n')]; // 승인자·날짜는 두 줄: 한 줄이면 휴대폰에서 칸 밖으로 넘침 (사용자 신고 11/19);
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

/** 인기(평점)는 결재란(신뢰성)과 따로 보인다 (docs/02 P1 '인기와 신뢰성 분리') */
export function Popularity({ r }: { r?: { avg: number; count: number } }) {
  return r ? <span className="meta">평점 <span className="num">{r.avg.toFixed(1)}</span> · {r.count}명</span> : null;
}

/** 「이름」: 전각 괄호 글리프의 안쪽 여백 때문에 '「 이름 」'처럼 띄어 보이는 것을 줄인다 (사용자 11/23, 데이터에는 공백 없음) */
export const Q = ({ children }: { children: ReactNode }) => <span className="q"><span className="ql">「</span>{children}<span className="qr">」</span></span>;
export const todayKst = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
const soon = (date?: string | null): date is string => !!date && date > todayKst();
const md = (date: string) => `${+date.slice(5, 7)}월 ${+date.slice(8, 10)}일`;

/** 제목 옆 '(2026-12-01 시행 예정)'. 시행일이 지나면 저절로 사라진다 (총괄 11/23: 제목은 고치지 않음) */
export function Scheduled({ date }: { date?: string | null }) {
  return soon(date) ? <span className="flag soon"> {date} 시행 예정</span> : null;
}

/** 현행판 카드·상세: 시행 예정 개정판 한 줄 + 그 버전 링크 */
export function Upcoming({ u }: { u?: LibraryCard['upcoming'] }) {
  return u && soon(u.effective_from) ? <p className="note"><Icon name="alert" />{md(u.effective_from)} 개정 예정 · <Link href={`/library?id=${encodeURIComponent(u.doc_id)}`} prefetch={false}>시행 예정 개정판{u.version_no ? ` v${u.version_no}` : ''} 보기</Link></p> : null;
}

/** '근거 규정이 바뀌어 재검토 중' + 바로 아래 이유 상자(aria-describedby로 연결). reason이 없으면 배너만 */
export function FreshnessFlag({ freshness, reason, max = 3, compact = false }: { freshness: SearchItem['freshness']; reason?: FreshnessReason | null; max?: number; compact?: boolean }) {
  const id = useId();
  if (freshness === 'SUPERSEDED') return <span className="flag"><Icon name="alert" />개정·폐지되어 현행이 아닌 판</span>;
  if (freshness !== 'REVIEW_REQUIRED') return null;
  const r = reason;
  const changes = r?.changes ?? [];
  const labels = changes.length ? changes.map((c) => c.label ?? readable(c.provision_id)) : (r?.provisions ?? []).map(readable);
  const flag = <><Icon name="alert" />근거 규정이 바뀌어 재검토 중</>;
  if (!r) return <span className="flag">{flag}</span>;
  const law = (r.law_name ?? '').trim();
  // 이유가 있으면 빨간 경고 상자 하나로: 제목 + '재검토 사유' (엔드유저·사용자 11/23). 날짜는 있는 것만 문장에 넣는다
  return <div className="reason-box" role="note" aria-labelledby={id}>
    <p className="reason-head" id={id}>{flag}</p>
    <p><b>재검토 사유</b> {r.deleted_doc ? <>근거로 쓰던 <Q>{law}</Q> 문서가 삭제되었습니다.</>
      : <>근거 규정 <Q>{law}</Q>{labels.length ? ` ${labels.join(', ')}` : ''}이 {r.effective_from && <><span className="num">{r.effective_from}</span> {soon(r.effective_from) ? '시행 예정인 ' : '시행 '}</>}개정판으로 바뀌었습니다.{r.cited_revision && <> 이 문서는 <span className="num">{r.cited_revision}</span> 판을 근거로 승인되었습니다.</>}{soon(r.effective_from) && ' 시행일 전까지는 현행 조문이 적용됩니다.'}</>}</p>
    {/* 목록 카드(compact)는 제목 + 사유 한 줄만, 전체는 상세에서 (엔드유저 13차: 카드가 너무 김) */}
    {!compact && changes.slice(0, max).map((c, i) => <div key={i}>
      {(c.old_text || c.new_text !== undefined) && <p><b>{c.label ?? readable(c.provision_id)}</b> <del>{c.old_text || '(없음)'}</del> → <ins>{c.new_text === '' ? '(개정본에서 삭제)' : c.new_text ?? '(확인 못 함)'}</ins></p>}
      {c.cited_text && <p><b>이 문서의 문장</b> {c.cited_text.replace(/^(\d+\.)(?=[^\s\d])/, '$1 ')}</p>}
    </div>)}
    {/* 결재자만 할 수 있는 행동은 결재자에게만 (엔드유저 11/23: 읽는 직원은 할 일이 없음) */}
    {compact ? null : isAdmin(getSession()?.groups) ? <><p><b>다음 할 일</b> {r.open_change_requests ? `수정 요청 ${r.open_change_requests}건 결재 대기 · ` : ''}고칠 것이 없으면 &apos;변경 없이 유효&apos;로 확인. 게시는 유지되며 수정 승인 전까지 자동으로 바뀌지 않습니다.</p>
      {soon(r.effective_from) && <p>수정 반영은 <span className="num">{r.effective_from}</span>부터 가능합니다. 개정 후에도 이 문서를 고칠 필요가 없으면 지금 [변경 없이 유효로 확인하기]를 눌러도 됩니다.</p>}</>
      : <p><b>읽는 분께</b> {soon(r.effective_from) ? <>시행일(<span className="num">{r.effective_from}</span>) 전까지는 현행 기준으로 업무하세요. </> : '바뀐 조문을 먼저 확인하고 업무에 쓰세요. '}담당 결재자가 이 문서를 고칠지 확인하고 있습니다.</p>}
  </div>;
}
