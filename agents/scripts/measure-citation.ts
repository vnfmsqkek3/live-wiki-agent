// 가이드 근거 인용 측정 (docs/02: 근거 인용 19/20 이상, UNVERIFIED를 '없다'로 단정 0건). prod 가이드 Runtime을 user 토큰으로 직접 호출.
// 케이스 기준일(as_of)을 Runtime에 넘긴다 (PR #97). 금지 문서(forbidden_doc_ids)는 fixture ID → 업로드 팀 결과 JSON으로 doc_id 매핑.
// 실행: set -a; . ./.env.local; set +a; node agents/scripts/measure-citation.ts [map.json …] (ONLY=CT-01,UV-02)
import { readFileSync } from 'node:fs';
import { aws, prodToken } from './prod-auth.ts';
import type { Evidence, GuideResult } from '../src/guide.ts';

const token = prodToken('user');
const arn = process.env.GUIDE_RUNTIME_ARN ?? aws(['bedrock-agentcore-control', 'list-agent-runtimes', '--query', "agentRuntimes[?agentRuntimeName=='hanaeum_mvp_rt_guide'].agentRuntimeArn | [0]"]);
const url = `https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/${encodeURIComponent(arn)}/invocations?qualifier=DEFAULT`;

async function ask(prompt: string, as_of: string): Promise<GuideResult> {
  const r = await fetch(url, { method: 'POST', body: JSON.stringify({ prompt, as_of }), headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json',
    'x-amzn-bedrock-agentcore-runtime-session-id': `eval-citation-${crypto.randomUUID()}` } });
  if (!r.ok) throw new Error(`guide ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json() as Promise<GuideResult>;
}
const cited = (g: GuideResult): Evidence[] => [...g.steps, ...(g.sections ?? []).flatMap((s) => s.steps)].flatMap((s) => s.sources);
const texts = (g: GuideResult) => [...g.steps, ...(g.sections ?? []).flatMap((s) => s.steps)].map((s) => s.text);

const docs = new Map<string, string>(); // fixture ID → prod doc_id
for (const f of process.argv.slice(2)) {
  const j = JSON.parse(readFileSync(f, 'utf8'));
  for (const [k, v] of Object.entries((j.docs ?? j) as Record<string, unknown>)) {
    const id = typeof v === 'string' ? v : (v as { doc_id?: string })?.doc_id;
    if (id?.startsWith('doc_')) docs.set(k, id);
  }
}
const only = process.env.ONLY?.split(',');
const read = (f: string) => readFileSync(new URL(`../../tests/evaluations/cases/${f}`, import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => !only || only.includes(c.id));

type CT = { id: string; question: string; as_of: string; expected_provision_ids: string[]; forbidden_provision_ids?: string[]; forbidden_doc_ids?: string[] };
let ok = 0; const cts = read('citation.jsonl') as CT[];
console.log('| ID | 판정 | 인용 provision_id | 사유 |\n|---|---|---|---|');
for (const c of cts) {
  try {
    const g = await ask(c.question, c.as_of);
    const ev = cited(g); const pids = ev.map((e) => e.provision_id).filter(Boolean) as string[];
    const why: string[] = [];
    if (!c.expected_provision_ids.some((p) => pids.includes(p))) why.push('정답 조문 미인용');
    const badP = (c.forbidden_provision_ids ?? []).filter((p) => pids.includes(p)); if (badP.length) why.push(`금지 조문 ${badP.join(',')}`);
    const unmapped = (c.forbidden_doc_ids ?? []).filter((f) => !docs.has(f));
    const badD = (c.forbidden_doc_ids ?? []).filter((f) => ev.some((e) => e.doc_id === docs.get(f))); if (badD.length) why.push(`금지 문서 ${badD.join(',')}`);
    if (unmapped.length) why.push(`(금지 문서 매핑 없음: ${unmapped.join(',')} — 확인 못 함)`);
    const pass = !why.some((w) => !w.startsWith('('));
    if (pass) ok++;
    console.log(`| ${c.id} | ${pass ? 'O' : 'X'} | ${[...new Set(pids)].join(' ') || g.status} | ${why.join('; ') || '-'} |`);
  } catch (e) { console.log(`| ${c.id} | X | - | 호출 실패 ${(e as Error).message} |`); }
}
if (cts.length) console.log(`근거 인용 ${ok}/${cts.length} (기준 19/20)\n`);

// UNVERIFIED: 근거가 없을 때 '없다/규정되어 있지 않다'로 단정하면 실패. 단정 탐지는 문구 휴리스틱 → 출력으로 사람이 재확인
const ABSENT = /(없습니다|없다|존재하지 않|규정(되어|하고) 있지 않|정해져 있지 않|해당 조문은 없)/;
let bad = 0; const uvs = read('unverified.jsonl') as { id: string; query: string; as_of: string }[];
console.log('| ID | 답변 상태 | 단정 | 첫 단계·불확실 |\n|---|---|---|---|');
for (const c of uvs) {
  try {
    const g = await ask(c.query, c.as_of);
    const hit = texts(g).find((t) => ABSENT.test(t));
    if (hit) bad++;
    console.log(`| ${c.id} | ${g.status} | ${hit ? 'X' : 'O'} | ${(hit ?? texts(g)[0] ?? g.uncertainty ?? '').slice(0, 80).replace(/\|/g, '/')} |`);
  } catch (e) { console.log(`| ${c.id} | 호출 실패 | - | ${(e as Error).message} |`); }
}
if (uvs.length) console.log(`UNVERIFIED 단정 ${bad}건 / ${uvs.length} (기준 0)`);
