'use client';
// 참조 확인 참고 제안 (interfaces 6.4): 문서에 없던 링크·버전을 공개 웹에서 확인한 주소. 근거로 인용하지 않는다.
// '정리본에 넣기' 는 위키 수정(6.2): 본문 끝에 참고 주소 줄을 붙인 편집기를 연다
export interface RefSuggestion { finding_id: string; page: number | null; item: string; reason: string; url: string; title: string; checked_at: string }
const REASON: Record<string, string> = { MISSING_LINK: '주소가 문서에 없음', INCONSISTENT: '문서 안에서 서로 다름', MAY_BE_OUTDATED: '바뀌었을 수 있음' };

export const withReference = (text: string, s: RefSuggestion) => `${text.trimEnd()}\n\n- 참고 주소 (${s.item}): ${s.url}`;

export function RefSuggestions({ items, onInsert }: { items: RefSuggestion[]; onInsert?: (s: RefSuggestion) => void }) {
  if (!items.length) return null;
  return (
    <section aria-labelledby="ref-h" className="ref-suggestions">
      <h3 className="section" id="ref-h">확인할 것: 웹에서 찾은 참고 주소 {items.length}건</h3>
      <p className="note">문서가 가리키지만 주소가 없거나 바뀌었을 수 있는 대상을 공개 웹에서 찾았습니다. 웹 정보라 근거로 인용하지 않습니다. 맞는지 확인한 뒤 넣으세요.</p>
      <ul className="fixes">{items.map((s) => (
        <li key={s.finding_id} className="fix">
          <p className="fix-head">{s.item}{s.page ? ` · ${s.page}쪽` : ''} · {REASON[s.reason] ?? s.reason}</p>
          <p><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title || s.url}</a></p>
          <p className="note">{s.url} · {new Date(s.checked_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} 확인</p>
          {onInsert && <div className="actions"><button type="button" className="btn" onClick={() => onInsert(s)}>정리본에 넣기</button></div>}
        </li>
      ))}</ul>
    </section>
  );
}
