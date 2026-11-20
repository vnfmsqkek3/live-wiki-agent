'use client';
// 관리 > Agent 평가 (데모 06, docs/02 6장): 정량 기준별 평가 결과, 실패 사례, 비인가 게시 거부(Policy Deny)와 Trace
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '../../lib/api';
import { PageHeader } from '../../page-header';
import { roleText } from '../../lib/roles';

interface Metric { key: string; label: string; target: string; passed: number; total: number; pass: boolean }
interface Failure { key: string; case_id: string; reason: string }
interface Denial { at: string; role: string; tool: string; reason: string; trace_id: string }
interface Evals { run_at: string | null; items: Metric[]; failures: Failure[]; denials: Denial[]; trace_url?: string }

// ponytail: 평가 실행 기록(EVALUATION_RUN)이 생기기 전까지 쓰는 화면 확인용 예시. API 404면 전체, run_at=null이면 평가 결과·실패 사례만 'mock' 표시와 함께 보여 준다 (거부 기록은 실제 값)
const MOCK_EVALS: Evals = {
  run_at: null,
  items: [
    { key: 'forged_block_5', label: '위조 규정 차단', target: '5건 모두 게시 차단', passed: 5, total: 5, pass: true },
    { key: 'attack_block_5', label: 'Prompt Injection KB 유입 차단', target: '5건 모두 차단', passed: 5, total: 5, pass: true },
    { key: 'knowhow_conflict_5', label: '노하우 충돌 탐지', target: '5건 중 4건 이상', passed: 4, total: 5, pass: true },
    { key: 'clause_lookup', label: '정확 조문 검색', target: '20건 중 19건 이상', passed: 20, total: 20, pass: true },
    { key: 'citation', label: '근거 인용', target: '20건 중 19건 이상', passed: 18, total: 20, pass: false },
    { key: 'unauthorized_publish', label: '비인가 게시 거부', target: '5건 모두 거부', passed: 5, total: 5, pass: true },
  ],
  failures: [{ key: 'citation', case_id: 'C-EXAMPLE', reason: '예시: 인용한 조문 번호가 정답과 다름' }],
  denials: [{ at: '2026-11-20T09:00:00Z', role: 'USER', tool: 'create_review_request', reason: '예시: 일반 사용자는 게시 도구를 호출할 수 없음', trace_id: 'trace-example' }],
};
// 거부 기록을 사람이 읽는 문장으로 (엔드유저 11/20). 원래 값은 '기술 정보'에 남긴다
const WHAT = (t: string) => /approv|decision|decide/i.test(t) ? '결재' : /submit|review_request|publish/i.test(t) ? '게시 요청' : /admin/i.test(t) ? '관리 기능 사용' : '권한이 필요한 작업';
const WHO = (r: string) => r.split(',').includes('AUTHOR') ? '작성자' : roleText(r.split(',')[0] ?? r);
const at = (s: string) => new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

export default function EvalsPage() {
  const [r, setR] = useState<Evals | null>(null);
  const [mock, setMock] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    api<Evals>('GET', '/v1/admin/evaluations').then((x) => {
      if (x.run_at === null) { setR({ ...x, items: MOCK_EVALS.items, failures: MOCK_EVALS.failures }); setMock(true); } else setR(x);
    }).catch((e: ApiError) => {
      if (e.status === 404) { setR(MOCK_EVALS); setMock(true); return; }
      setErr(e.status === 403 ? '결재 권한이 있는 계정만 볼 수 있습니다.' : e.message); setR(null);
    });
  }, []);
  return (
    <>
      <PageHeader title="Agent 평가" description="합성 평가 세트로 잰 검색·인용·보안 결과와, 권한 없는 게시 시도를 거부한 기록입니다." action={<Link className="btn" href="/admin">관리로 돌아가기</Link>} />
      {mock && <p className="notice" role="status">mock: 아직 평가 실행 기록이 없어 평가 결과·실패 사례는 예시 값입니다. 실제 측정 결과가 아닙니다.</p>}
      {err && <p className="error" role="alert">{err}</p>}
      {!r && !err && <p className="note">불러오는 중입니다.</p>}
      {r && (
        <div>
          <section aria-labelledby="ev-h">
            <h2 className="section" id="ev-h">평가 결과 <span className="note">{r.run_at ? `측정 ${at(r.run_at)}` : '측정 시각 없음'}</span></h2>
            <div className="doc-table"><table>
              <tbody><tr><th scope="col">항목</th><th scope="col">기준</th><th scope="col">결과</th><th scope="col">판정</th></tr>{r.items.map((m) => (
                <tr key={m.key}><th scope="row">{m.label}</th><td>{m.target}</td><td className="num">{m.passed}/{m.total}</td>
                  <td>{mock ? <span className="run-status wait">예시</span> : <span className={`run-status ${m.pass ? 'ok' : 'bad'}`}>{m.pass ? '합격' : '미달'}</span>}</td></tr>
              ))}</tbody>
            </table></div>
          </section>
          <section aria-labelledby="fail-h">
            <h2 className="section" id="fail-h">실패 사례 {r.failures.length}건</h2>
            {r.failures.length === 0 ? <p className="note">실패한 사례가 없습니다.</p> : (
              <ul className="ledger">{r.failures.map((f) => (
                <li className="entry" key={`${f.key}-${f.case_id}`}><h3 className="doc-title">{f.case_id} · {r.items.find((m) => m.key === f.key)?.label ?? f.key}</h3><p className="meta">{f.reason}</p></li>
              ))}</ul>
            )}
          </section>
          <section aria-labelledby="deny-h">
            <h2 className="section" id="deny-h">비인가 게시 거부 {r.denials.length}건</h2>
            {r.trace_url && <p className="note"><a href={r.trace_url} target="_blank" rel="noreferrer">거부 Trace 보기 (CloudWatch)</a></p>}
            {r.denials.length === 0 ? <p className="note">거부 기록이 없습니다.</p> : (
              <ul className="ledger">{r.denials.map((d) => (
                <li className="entry" key={d.trace_id + d.at}>
                  <span className="run-status bad">거부</span>
                  <h3 className="doc-title">{/owner/i.test(d.reason) ? `본인 문서가 아니어서 ${WHAT(d.tool)} 시도를 거부함` : `${WHO(d.role)} 계정의 ${WHAT(d.tool)} 시도를 권한이 없어 거부함`}</h3>
                  <p className="meta">{at(d.at)} · 역할 {roleText(d.role).replace(/,/g, '·')}</p>
                  <details><summary className="note">기술 정보</summary><p className="meta">{d.tool} · {d.reason} · Trace {d.trace_id}</p></details>
                </li>
              ))}</ul>
            )}
          </section>
        </div>
      )}
    </>
  );
}
