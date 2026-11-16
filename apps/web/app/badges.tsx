import type { SearchItem } from './lib/api';

/** 신뢰 상태 배지. 인기(별점)와 신뢰성은 분리해 표시한다. */
export function TrustBadges({ i }: { i: Pick<SearchItem, 'authority_status' | 'freshness' | 'document_type'> }) {
  return (
    <span className="row">
      {i.document_type === 'REGULATION' && i.authority_status === 'VERIFIED' && <span className="badge b-info">공식 규정</span>}
      {i.document_type !== 'REGULATION' && i.authority_status === 'VERIFIED' && <span className="badge b-ok">검증 완료</span>}
      {i.authority_status === 'UNVERIFIED' && <span className="badge b-warn">미검증</span>}
      {i.freshness === 'CURRENT' ? <span className="badge b-ok">최신성 확인</span> : <span className="badge b-warn">검토 필요</span>}
    </span>
  );
}
