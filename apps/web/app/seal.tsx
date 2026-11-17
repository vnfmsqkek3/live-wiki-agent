import type { SearchItem } from './lib/api';

/** 신뢰 상태 인장. 공식 규정만 인주색. 인기(별점)와 신뢰성은 따로 표시한다. */
export function Seal({ i, stamp }: { i: Pick<SearchItem, 'authority_status' | 'document_type'>; stamp?: boolean }) {
  const [cls, text, label] =
    i.authority_status !== 'VERIFIED' ? ['unverified', '미검증', '미검증 문서']
    : i.document_type === 'REGULATION' ? ['official', '공식\n규정', '공식 규정 원본과 일치']
    : ['verified', '검증\n완료', i.document_type === 'MANUAL' ? '사람 승인으로 검증 완료' : '근거 규정 확인 후 사람 승인으로 검증 완료'];
  return (
    <span className={`seal ${cls}${stamp ? ' stamp' : ''}`} role="img" aria-label={label} style={{ whiteSpace: 'pre-line' }}>
      {text}
    </span>
  );
}

export function FreshnessFlag({ freshness }: { freshness: SearchItem['freshness'] }) {
  if (freshness === 'SUPERSEDED') return <span className="flag">개정·폐지되어 현행이 아닌 판</span>;
  return freshness === 'REVIEW_REQUIRED' ? <span className="flag">근거 규정이 바뀌어 재검토 중</span> : null;
}
