'use client';
// 올린 사람에게 "몇 쪽 어디가 왜, 어떻게 고치는지" (사용자 지시 11/17). 쪽 이미지는 개인정보를 가린 마스킹본만 보여 준다
import { Icon } from './icons';
import { useEffect, useState } from 'react';
import { api, ApiError, apiBlobUrl, type DocChange, type Explanation, type Issue, type Issues, type VersionCandidates, type VersionDiff } from './lib/api';

const SEV: Record<Issue['severity'], string> = { HIGH: '등록 불가·수정 필요', MEDIUM: '확인 필요', LOW: '참고' };

// 어려운 용어 쉬운 말 병기 (엔드유저 D02 11/20). 문장마다 처음 한 번만
const plain = (s: string) => s.replace(/프롬프트 인젝션(?!\()/, '프롬프트 인젝션(AI를 속이는 숨은 지시문)').replace(/HTML 주석(?!\()/, 'HTML 주석(화면에 보이지 않는 메모 칸)');

/** AgentCore가 확인 결과를 사람이 읽을 문장으로 정리한 설명 (판정은 바꾸지 않음) */
function ExplainView({ e, issues, pages, onPage }: { e: Explanation; issues: Issue[]; pages: number[]; onPage: (p: number) => void }) {
  const pageOf = (id: string, p?: number) => p ?? issues.find((i) => i.finding_id === id)?.location?.page;
  return (
    <div className="explain">
      <p className="lead" style={{ marginTop: 0 }}>{plain(e.summary)}</p>
      <ul className="fixes">
        {e.items.map((it) => {
          const p = pageOf(it.finding_id, it.page);
          return (
            <li key={it.finding_id} className={`fix ${it.risk === '높음' ? 'sev-HIGH' : ''}`}>
              <p className="fix-head">{p && !it.where.startsWith(`${p}쪽`) ? `${p}쪽 · ` : ''}{plain(it.where)} <span className={it.risk === '높음' ? 'danger-text' : 'note'}>· 위험도 {it.risk}</span></p>
              <p><strong>무엇이</strong> {plain(it.problem)}</p>
              <p><strong>왜</strong> {plain(it.reason)}</p>
              <p><strong>고치는 방법</strong> {plain(it.fix)}</p>
              {p && pages.includes(p) && <button className="btn" type="button" onClick={() => onPage(p)}>{p}쪽에서 위치 보기</button>}
            </li>
          );
        })}
      </ul>
      {e.next_action && <p><strong><Icon name="arrow" /> 다음에 할 일</strong> {plain(e.next_action)}</p>}
      <p className="meta">AI가 검사 결과를 설명한 내용입니다. 등록 가능 여부 판정은 검사 규칙이 정하며, 설명이 판정을 바꾸지 않습니다.</p>
    </div>
  );
}

export function PageView({ docId, page, items, onClose }: { docId: string; page: number; items: Issue[]; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let u = '';
    apiBlobUrl(`/v1/documents/${encodeURIComponent(docId)}/pages/${page}/image`).then((x) => { u = x; setUrl(x); }).catch(() => setErr('이 쪽은 이미지가 없습니다. 아래 문장으로 위치를 확인해 주세요.'));
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [docId, page]);
  const boxes = items.flatMap((i) => i.location?.bbox ?? []);
  return (
    <div className="page-view">
      <div className="actions" style={{ marginTop: 0 }}><strong>{page}쪽</strong><button className="btn" type="button" onClick={onClose}>닫기</button></div>
      {err ? <p className="note">{err}</p> : !url ? <p className="note">불러오는 중입니다.</p> : (
        <div className="page-img">
          <img src={url} alt={`${page}쪽 (개인정보를 가린 이미지)`} onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
          {size && boxes.map(([x0, y0, x1, y1], i) => (
            <span key={i} className="bbox" aria-hidden="true" style={{ left: `${(x0! / size.w) * 100}%`, top: `${(y0! / size.h) * 100}%`, width: `${((x1! - x0!) / size.w) * 100}%`, height: `${((y1! - y0!) / size.h) * 100}%` }} />
          ))}
        </div>
      )}
    </div>
  );
}

export function IssueList({ docId, refreshKey }: { docId: string; refreshKey?: unknown }) {
  const [d, setD] = useState<Issues | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [openAt, setOpenAt] = useState<number | null>(null); // 위치 보기를 누른 항목
  useEffect(() => { api<Issues>('GET', `/v1/documents/${encodeURIComponent(docId)}/issues`).then(setD).catch(() => setD(null)); }, [docId, refreshKey]);
  if (!d) return null;
  // 항목별 확인 대상(개인정보·비밀값 MEDIUM)은 검토 화면 위쪽 '개인정보 확인'에서 처리하므로 여기서 뺀다 (Fable 권고 11/18)
  const REVIEW = new Set(['PII_IMAGE_REVIEW', 'PII_IN_FIGURE', 'PII_GUARDRAIL', 'SECRET_MASKED']);
  const shown = d.items.filter((i) => i.severity !== 'LOW' && !(i.severity === 'MEDIUM' && REVIEW.has(i.code)));
  // LOW 중 *_SKIPPED는 처리한 것이 아니라 확인하지 못한 것 (AI 규칙, 엔드유저 U2 11/20)
  const skipped = d.items.filter((i) => i.severity === 'LOW' && i.code.endsWith('_SKIPPED'));
  const info = d.items.filter((i) => i.severity === 'LOW' && !i.code.endsWith('_SKIPPED'));
  return (
    <section aria-labelledby="issues-h" className="issues">
      <h2 className="section" id="issues-h"><Icon name="alert" /> 확인할 내용 {shown.length > 0 && <span className="danger-text">{shown.length}건</span>}</h2>
      {d.explanation && <ExplainView e={d.explanation} issues={d.items} pages={d.page_images} onPage={setOpen} />}
      {shown.length === 0 && <p className="note">고쳐야 할 내용이 없습니다.</p>}
      {d.explanation && shown.length > 0 && <h3 className="section" style={{ fontSize: '.9rem' }}>검사 항목별 결과</h3>}
      <ul className="fixes">
        {shown.map((i, n) => (
          <li key={n} className={`fix sev-${i.severity}`}>
            <p className="fix-head">{i.step_label}{i.location?.page && <> · {i.location.page}쪽</>} <span className={i.severity === 'HIGH' ? 'danger-text' : 'note'}>· {SEV[i.severity]}</span></p>
            <p>{i.user_message}</p>
            {i.location?.excerpt && <blockquote className="basis"><p>{i.location.excerpt}</p></blockquote>}
            {i.fix_hint && <p><strong>고치는 방법</strong> {i.fix_hint}</p>}
            {i.location?.page && d.page_images.includes(i.location.page) && (
              <button className="btn" type="button" aria-expanded={openAt === n} onClick={() => { setOpen(i.location!.page!); setOpenAt(n); }}>{i.location.page}쪽에서 위치 보기</button>
            )}
            {/* 누른 항목 바로 아래에 연다 (11/18 사용자 보고: 목록 맨 아래에 열려 화면 밖이라 아무것도 안 뜨는 것처럼 보임) */}
            {open !== null && openAt === n && <PageView docId={docId} page={open} items={d.items.filter((x) => x.location?.page === open)} onClose={() => { setOpen(null); setOpenAt(null); }} />}
          </li>
        ))}
      </ul>
      {open !== null && openAt === null && <PageView docId={docId} page={open} items={d.items.filter((i) => i.location?.page === open)} onClose={() => setOpen(null)} />}
      {skipped.length > 0 && <>
        <p className="note" style={{ marginTop: 12 }}>확인하지 못한 내용 {skipped.length}건 (승인자가 직접 확인)</p>
        <ul className="fixes">{skipped.map((i, n) => <li key={n} className="fix"><p style={{ margin: 0 }}>{i.user_message}</p></li>)}</ul>
      </>}
      {info.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary className="note">자동으로 처리한 내용 {info.length}건</summary>
          <ul className="fixes">{info.map((i, n) => <li key={n} className="fix"><p style={{ margin: 0 }}>{i.user_message}</p></li>)}</ul>
        </details>
      )}
    </section>
  );
}

/** 쪽 성격·핵심어·본문 속 조문 표기 (PageSummarize) */
export function PageFacts({ m }: { m: { keywords?: string[]; clause_refs?: string[]; clause_groups?: { law: string | null; clauses: string[] }[]; page_type?: string } }) {
  if (!m.page_type && !m.keywords?.length && !m.clause_refs?.length) return null;
  // 규정 이름과 묶어서 보여 주고, 누르면 '규정 이름 + 조문'으로 찾는다 ('제1조'만으로 찾으면 아무 규정이나 나옴)
  const groups = m.clause_groups ?? [{ law: null, clauses: m.clause_refs ?? [] }];
  return (
    <dl className="meta-grid">
      {m.page_type && <><dt>쪽 성격</dt><dd>{m.page_type}</dd></>}
      {!!m.keywords?.length && <><dt>핵심어</dt><dd><span className="keyword">{m.keywords.join(', ')}</span></dd></>}
      {!!m.clause_refs?.length && <><dt>인용 조문</dt><dd className="clause-groups">{groups.map((g) => (
        <p key={g.law ?? '-'}><strong>{g.law ?? '규정 이름 표기 없음'}</strong>{' '}
          {g.clauses.map((c, i) => <span key={c}>{i > 0 && ', '}{g.law ? <a href={`/search?q=${encodeURIComponent(`${g.law} ${c}`)}`}>{c}</a> : c}</span>)}
        </p>
      ))}</dd></>}
    </dl>
  );
}

const CHANGE_KIND = { ADDED: '추가', REMOVED: '삭제', CHANGED: '변경' } as const;

/** 이전 버전과 바뀐 곳: 위치·종류·이전 → 새 문구. 숫자가 바뀌면 따로 표시 */
export function Changes({ diff }: { diff: VersionDiff }) {
  const [all, setAll] = useState(false);
  const shown = all ? diff.changes : diff.changes.slice(0, 10);
  return (
    <section aria-labelledby="chg-h">
      <h3 className="section" id="chg-h">v{diff.previous.version_no}과 바뀐 곳 <span className="note">{diff.count}건</span></h3>
      {diff.count === 0 ? <p className="note">내용이 바뀐 곳이 없습니다.</p>
        : !diff.changes.length ? <p className="note">이전 버전을 볼 권한이 없어 바뀐 내용은 표시하지 않습니다.</p> : (
        <ul className="fixes">
          {shown.map((c: DocChange, n) => (
            <li key={n} className={`fix chg-${c.kind}`}>
              <p className="fix-head">{c.where} · {CHANGE_KIND[c.kind]}</p>
              {c.numbers_changed && <p className="danger-text" style={{ margin: 0 }}>숫자 변경: {c.numbers_changed.old.join(', ')} → {c.numbers_changed.new.join(', ')}</p>}
              <dl className="trio">
                {c.kind !== 'ADDED' && <><dt>이전</dt><dd><del>{c.old_text}</del></dd></>}
                {c.kind !== 'REMOVED' && <><dt>새 버전</dt><dd><ins>{c.new_text}</ins></dd></>}
              </dl>
            </li>
          ))}
        </ul>
      )}
      {diff.changes.length > 10 && !all && <button type="button" className="linklike" onClick={() => setAll(true)}>바뀐 곳 모두 보기 ({diff.changes.length}건)</button>}
    </section>
  );
}

/** 업로드 검토: 이전 버전 후보를 보여 주고 작성자가 확인하면 연결 (자동 연결 안 함) */
export function VersionLink({ docId, canEdit }: { docId: string; canEdit: boolean }) {
  const [v, setV] = useState<VersionCandidates | null>(null);
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [msg, setMsg] = useState('');
  const load = () => api<VersionCandidates>('GET', `/v1/documents/${encodeURIComponent(docId)}/version-candidates`).then(setV).catch(() => setV({ linked: null, items: [] }));
  useEffect(() => { void load(); }, [docId]);
  useEffect(() => {
    if (!v?.linked) { setDiff(null); return; }
    api<{ diff: VersionDiff | null }>('GET', `/v1/library/${encodeURIComponent(docId)}/versions`).then((r) => setDiff(r.diff)).catch(() => setDiff(null));
  }, [v?.linked, docId]);
  async function link(id: string | null) {
    try { await api('POST', `/v1/documents/${encodeURIComponent(docId)}/previous`, { previous_doc_id: id }); setMsg(id ? '이전 버전과 연결했습니다. 승인되면 이전 버전은 검색에서 빠집니다.' : '연결을 끊었습니다.'); await load(); }
    catch (e) { setMsg((e as ApiError).message); }
  }
  if (!v) return null;
  if (v.linked) return (
    <section aria-labelledby="ver-h">
      <h2 className="section" id="ver-h">버전</h2>
      <p>이 문서는 「{v.linked.title}」 v{v.linked.version_no}의 새 버전(v{v.version_no ?? v.linked.version_no + 1})입니다.
        {canEdit && <> <button type="button" className="linklike" onClick={() => link(null)}>연결 끊기</button></>}</p>
      {diff && <Changes diff={diff} />}
      {msg && <p className="note" aria-live="polite">{msg}</p>}
    </section>
  );
  if (!v.items.length || dismissed || !canEdit) return null;
  return (
    <section aria-labelledby="ver-h" className="notice" style={{ display: 'block' }}>
      <h2 className="section" id="ver-h" style={{ marginTop: 0 }}>이미 게시된 문서의 새 버전인가요?</h2>
      <p className="note">새 버전으로 연결하면 바뀐 곳을 비교해 보여 주고, 승인되면 이전 버전은 '대체됨'으로 바뀌어 검색에서 빠집니다.</p>
      <ul className="fixes">
        {v.items.map((c) => (
          <li key={c.doc_id} className="fix">
            <p className="fix-head">{c.title}</p>
            <p className="note" style={{ margin: 0 }}>{c.reason}</p>
            <div className="actions"><button className="btn solid" onClick={() => link(c.doc_id)}>이 문서의 새 버전으로 연결</button></div>
          </li>
        ))}
      </ul>
      <button type="button" className="btn" onClick={() => setDismissed(true)}>새 문서입니다</button>
      {msg && <p className="note" aria-live="polite">{msg}</p>}
    </section>
  );
}
