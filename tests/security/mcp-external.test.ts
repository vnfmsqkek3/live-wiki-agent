// 외부 MCP(hanaeum-wiki-mcp) 보안 테스트 (총괄 지시 11/20, interfaces.md 11장, 인터셉터 mcp/gateway-interceptor).
// 실행 중인 사용자 Gateway에 외부 클라이언트(client_credentials) 토큰으로 직접 요청하는 블랙박스 테스트.
// 실행: set -a; . ./.env.local; set +a; eval "$(apps/api/scripts/ssm-env.sh prod)"; node --test tests/security/mcp-external.test.ts
// 문서 ID는 거버넌스 DB(PostgreSQL)에서 고른다. 직접 주려면 DOC_PUBLIC·DOC_UNPUBLISHED·DOC_DEPT.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { detectPii } from '@hanaeum/pii';

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`missing env ${k} (ssm-env.sh 먼저)`); return v; };
const aws = (...args: string[]) => execFileSync('aws', [...args, '--output', 'json'], { encoding: 'utf8' });
const SECRET = process.env.MCP_CLIENT_SECRET_ID ?? 'hanaeum-mvp/mcp-external-client';

let token = '';
const docs = { public: '', unpublished: '', dept: '' };

/** MCP JSON-RPC 1건. 응답이 SSE 면 data 줄의 JSON 을 꺼낸다 */
async function mcp(method: string, params: Record<string, unknown> = {}, tok: string | null = token) {
  const r = await fetch(env('USER_GATEWAY_URL'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const raw = await r.text();
  const json = raw.trim().startsWith('{') ? raw : raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('');
  return { status: r.status, raw, body: (JSON.parse(json || '{}') as { result?: { content?: { text?: string }[]; isError?: boolean; tools?: { name: string }[] }; error?: { message: string } }) };
}
const call = (name: string, args: Record<string, unknown>) => mcp('tools/call', { name, arguments: args });
/** Tool 결과 본문 (Lambda 반환 JSON). 인터셉터 거부는 JSON-RPC error */
const out = (b: Awaited<ReturnType<typeof mcp>>['body']) => { try { return JSON.parse(b.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>; } catch { return {}; } };
// 거부 = 결과 없이 JSON-RPC 오류. 인터셉터(forbidden·unauthenticated) 또는 그 앞의 Gateway JWT 검사(insufficient_scope 등)
const denied = (b: Awaited<ReturnType<typeof mcp>>['body']) => !b.result && /forbidden|unauthenticated|insufficient_scope|unauthorized|invalid_token/i.test(b.error?.message ?? '');

function sql(q: string) {
  const r = JSON.parse(aws('rds-data', 'execute-statement', '--resource-arn', env('DB_CLUSTER_ARN'), '--secret-arn', env('DB_SECRET_ARN'), '--database', env('DB_NAME'), '--sql', q)) as { records?: { stringValue?: string }[][] };
  return r.records?.[0]?.[0]?.stringValue ?? '';
}

before(async () => {
  const s = JSON.parse(JSON.parse(aws('secretsmanager', 'get-secret-value', '--secret-id', SECRET, '--query', 'SecretString'))) as { client_id: string; client_secret: string; token_endpoint: string; scope: string };
  const r = await fetch(s.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${s.client_id}:${s.client_secret}`).toString('base64')}` },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: s.scope }) });
  token = ((await r.json()) as { access_token?: string }).access_token ?? '';
  assert.ok(token, '외부 클라이언트 토큰');
  // 시행 전 개정본(effective_from 미래)은 오늘 기준 조회에서 NOT_FOUND 가 정상 → 시행 중인 문서만
  docs.public = process.env.DOC_PUBLIC ?? sql("SELECT doc_id FROM documents WHERE lifecycle='PUBLISHED' AND freshness<>'SUPERSEDED' AND 'ALL'=ANY(acl_groups) AND coalesce(attrs->>'effective_from','') <= to_char(now(),'YYYY-MM-DD') ORDER BY updated_at DESC LIMIT 1");
  docs.unpublished = process.env.DOC_UNPUBLISHED ?? sql("SELECT doc_id FROM documents WHERE lifecycle IN ('IN_REVIEW','PENDING_APPROVAL','QUARANTINED') ORDER BY updated_at DESC LIMIT 1");
  docs.dept = process.env.DOC_DEPT ?? sql("SELECT doc_id FROM documents WHERE lifecycle='PUBLISHED' AND NOT ('ALL'=ANY(acl_groups)) ORDER BY updated_at DESC LIMIT 1");
});

test('인증: 토큰 없음·위조 서명 토큰은 도구 호출 거부', async () => {
  const [h, p] = token.split('.');
  for (const t of [null, `${h}.${p}.AAAA`]) {
    const r = await mcp('tools/call', { name: 'search___search_wiki', arguments: { query: '담보' } }, t);
    assert.ok(r.status === 401 || denied(r.body), r.raw.slice(0, 200));
  }
});

test('읽기 도구만 허용: search_wiki·get_wiki_document 는 결과, 쓰기·민감 도구 6종은 모두 거부', async () => {
  const s = await call('search___search_wiki', { query: '담보' });
  assert.ok(!denied(s.body) && s.body.result, s.raw.slice(0, 200));
  for (const name of ['approval___create_review_request', 'approval___draft_change', 'approval___get_status', 'privacy___detect_sensitive_data', 'privacy___masking_preview', 'regulation___fetch_official_law']) {
    const r = await call(name, { doc_id: docs.public, text: 'x', law_name: '은행법' });
    assert.ok(denied(r.body), `${name} 허용됨: ${r.raw.slice(0, 200)}`);
  }
  // 게시·규정 승인 도구는 Gateway 에 아예 없다 (사람만 Backend API 로)
  const tl = (await mcp('tools/list')).body.result?.tools?.map((t) => t.name) ?? [];
  assert.ok(!tl.some((n) => /publish|approve/.test(n)), tl.join(','));
});

test('ACL: 공개 게시 문서만. 미게시·부서 ACL 문서는 NOT_FOUND, 위조 __actor 도 무시', async () => {
  assert.ok(docs.public, '공개 게시 문서 없음 (시드 필요)');
  const pub = out((await call('search___get_wiki_document', { doc_id: docs.public })).body);
  assert.equal(pub.doc_id, docs.public, JSON.stringify(pub).slice(0, 200));
  const forged = { __actor: { sub: 'attacker', groups: ['REG_APPROVER', 'PLATFORM_OPERATOR'], dept: 'loan' } };
  for (const [k, id] of [['unpublished', docs.unpublished], ['dept', docs.dept]] as const) {
    if (!id) { console.log(`skip ${k}: 대상 문서 없음`); continue; }
    for (const a of [{}, forged]) {
      const r = (await call('search___get_wiki_document', { doc_id: id, ...a })).body;
      const o = out(r);
      assert.ok(o.doc_id !== id && JSON.stringify(r).includes('NOT_FOUND'), `${k} ${id} 노출: ${JSON.stringify(r).slice(0, 200)}`);
    }
  }
  // 검색에도 미게시·부서 문서가 섞이지 않는다
  const hits = (out((await call('search___search_wiki', { query: '업무', top_k: 10 })).body).items ?? []) as { doc_id: string }[];
  assert.ok(!hits.some((h) => h.doc_id === docs.unpublished || h.doc_id === docs.dept));
});

test('응답에 원문 PII 없음: 검색·정리본에 주민등록번호·카드·계좌 형식이 나오지 않음', async () => {
  const bodies = [
    (await call('search___search_wiki', { query: '고객 주민등록번호 계좌' })).raw,
    ...(docs.public ? [(await call('search___get_wiki_document', { doc_id: docs.public })).raw] : []),
  ];
  // 검색 score 실수의 소수부(16자리)가 카드 형식에 걸린다 → 점수 숫자는 빼고 본다
  for (const b of bodies) assert.deepEqual(detectPii(b.replace(/\\n/g, '\n').replace(/\\?"score\\?":[\d.e-]+/g, '')).map((x) => x.type), [], '원문 PII 형식');
});
