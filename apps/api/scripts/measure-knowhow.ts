// 노하우 충돌 정량 측정 (docs/02 4장 "노하우 충돌 5건 중 4건 이상", 측정 Owner dhxorb96). 실모델 호출.
// 사용: git archive origin/let522mj tests/fixtures | tar -x -C <dir>
//       AWS_REGION=us-east-1 MODEL_SONNET=<id> node apps/api/scripts/measure-knowhow.ts <dir>/tests/fixtures
//       REAL=1 (+ ssm-env: TABLE_REGULATIONS·KB_ID·TABLE_DOCUMENTS·MODEL_RERANK) → TrustGate와 같은 실제 의존성(규정 저장소·KB 검색) 사용
// 기본 모드의 조문 파서·인용 추출·의미 검색은 측정용 최소 구현 (REAL=1이 실제 경로)
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { structured } from '../src/model.ts';
import { detectPii, mask } from '../src/steps/pii-detect.ts';
import { JUDGE_SCHEMA, JUDGE_SYSTEM, judgePrompt, SUGGEST_SCHEMA, SUGGEST_SYSTEM, suggestPrompt, validateKnowhow, type Clause, type Judgement } from '../src/steps/knowhow.ts';

const dir = process.argv[2];
if (!dir) throw new Error('fixtures dir 필요');
const read = (f: string) => readFileSync(join(dir, f), 'utf8');

// ---- 규정 파싱 (조·항 단위) ----
type Law = { law_id: string; rev: string; title: string; clauses: Clause[] };
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩';
function parseLaw(text: string): Law {
  const no = /문서번호:\s*HB-REG-([A-Z]+)-(\d+)/.exec(text)!;
  const d = /시행일:\s*(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\./.exec(text)!;
  const rev = `${d[1]}-${d[2]!.padStart(2, '0')}-${d[3]!.padStart(2, '0')}`;
  const law_id = `SYN-${no[1]}-${no[2]}`;
  const title = text.split('\n')[2]!.replace(/^(한빛|하나)은행\s*/, '').trim();
  const clauses: Clause[] = [];
  let art = '';
  let cur: Clause | undefined;
  for (const line of text.split('\n')) {
    if (/^부칙/.test(line)) { art = ''; cur = undefined; continue; }
    const a = /^제(\d+)조(?:의(\d+))?\(([^)]*)\)\s*(.*)$/.exec(line);
    if (a) {
      art = `ARTICLE:${a[1]}${a[2] ? `-${a[2]}` : ''}`;
      const label = `${title} 제${a[1]}조${a[2] ? `의${a[2]}` : ''}`;
      const rest = a[4]!;
      const p = rest[0] && CIRCLED.indexOf(rest[0]) >= 0 ? CIRCLED.indexOf(rest[0]) + 1 : 0;
      cur = { provision_id: `${law_id}@${rev}/${art}${p ? `/PARAGRAPH:${p}` : ''}`, label: p ? `${label}제${p}항` : label, text: p ? rest.slice(1).trim() : rest, status: 'ACTIVE', effective_from: rev };
      clauses.push(cur);
      continue;
    }
    const p = line[0] ? CIRCLED.indexOf(line[0]) : -1;
    if (art && p >= 0) {
      const base = clauses.at(-1)!.label.replace(/제\d+항$/, '');
      cur = { provision_id: `${law_id}@${rev}/${art}/PARAGRAPH:${p + 1}`, label: `${base}제${p + 1}항`, text: line.slice(1).trim(), status: 'ACTIVE', effective_from: rev };
      clauses.push(cur);
    } else if (cur && /^\d+\./.test(line)) cur.text += ` ${line.trim()}`;
  }
  return { law_id, rev, title, clauses };
}

const laws = [...['documents/F-000.txt', 'documents/F-001.txt'], ...readdirSync(join(dir, 'golden')).filter((f) => f.startsWith('G-REG')).map((f) => `golden/${f}`)]
  .map((f) => parseLaw(read(f)));
// 같은 법령의 여러 버전: 최신이 현행, 나머지는 HISTORICAL + current 연결
const byLaw = new Map<string, Law[]>();
for (const l of laws) byLaw.set(l.law_id, [...(byLaw.get(l.law_id) ?? []), l].sort((a, b) => a.rev.localeCompare(b.rev)));
const clauseIndex = new Map<string, Clause>();
for (const versions of byLaw.values()) {
  const latest = versions.at(-1)!;
  for (const v of versions) for (const c of v.clauses) {
    const current = latest.clauses.find((x) => x.provision_id.split('/').slice(1).join('/') === c.provision_id.split('/').slice(1).join('/'));
    clauseIndex.set(c.provision_id, v === latest ? c : { ...c, status: 'HISTORICAL', ...(current ? { current } : {}) });
  }
}
const currentClauses = [...byLaw.values()].flatMap((v) => v.at(-1)!.clauses);

// ---- 인용 추출 (법령명 문맥 + 제N조제M항, "YYYY. M. D. 시행본"이면 그 버전) ----
async function extractCitations(text: string) {
  const out: { provision_id: string; evidence_span: string; confidence: number }[] = [];
  let law: Law[] | undefined;
  let rev: string | undefined;
  const re = /([가-힣]+(?:규정|지침|세칙))|(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.\s*시행본|제(\d+)조(?:의(\d+))?(?:제(\d+)항)?/g;
  for (const m of text.matchAll(re)) {
    if (m[1]) { const hit = [...byLaw.values()].find((v) => v[0]!.title.replace(/\s/g, '').includes(m[1]!)); if (hit) { law = hit; rev = undefined; } continue; }
    if (m[2]) { rev = `${m[2]}-${m[3]!.padStart(2, '0')}-${m[4]!.padStart(2, '0')}`; continue; }
    if (!law) continue;
    const v = law.find((x) => x.rev === rev) ?? law.at(-1)!;
    const id = `${v.law_id}@${v.rev}/ARTICLE:${m[5]}${m[6] ? `-${m[6]}` : ''}${m[7] ? `/PARAGRAPH:${m[7]}` : ''}`;
    const ok = clauseIndex.has(id) || clauseIndex.has(`${id}/PARAGRAPH:1`);
    out.push({ provision_id: clauseIndex.has(id) ? id : `${id}/PARAGRAPH:1`, evidence_span: m[0], confidence: ok ? 0.9 : 0.3 });
  }
  return out;
}

// ---- 의미 검색 대용: 글자 2-gram 겹침 상위 5 (현행 조문) ----
const grams = (s: string) => { const t = s.replace(/\s+/g, ''); const g = new Set<string>(); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g; };
async function searchClauses(text: string) {
  const q = grams(text);
  return currentClauses.map((c) => ({ c, s: [...grams(c.text)].filter((g) => q.has(g)).length })).sort((a, b) => b.s - a.s).slice(0, 5).map((x) => x.c);
}

// REAL=1: TrustGate Lambda와 같은 의존성 (handlers.ts와 동일 구성)
async function realDeps() {
  const { DynamoClauseStore, regulationTools } = await import('@hanaeum/regulation-server');
  const { BedrockRetriever, DynamoDocStates, searchTools } = await import('@hanaeum/search-server');
  const { extractCitations: extract } = await import('@hanaeum/graph-server');
  const { knowhowDeps } = await import('../src/knowhow-deps.ts');
  const e = process.env;
  const clauses = new DynamoClauseStore(e.TABLE_REGULATIONS!);
  const search = searchTools({ retriever: new BedrockRetriever(e.KB_ID!, e.MODEL_RERANK), states: new DynamoDocStates(e.TABLE_DOCUMENTS!), regulation: regulationTools(clauses) });
  return knowhowDeps({
    store: clauses as never,
    extract: (t, st, asOf) => extract(t, st as never, asOf),
    searchProvisionIds: async (q) => ((await search.search_wiki({ query: q, index_groups: ['legal-clauses'], top_k: 5 }, { sub: 'system:measure', groups: ['REG_APPROVER'] })).items ?? [])
      .filter((i) => i.search_status === 'FOUND').map((i) => i.provision_id).filter(Boolean),
    judge,
    suggest: async (items) => (await structured<{ suggestions: string[] }>('HAIKU', SUGGEST_SYSTEM, suggestPrompt(items), 'submit_suggestions', SUGGEST_SCHEMA as unknown as Record<string, unknown>)).value.suggestions,
  });
}

const judge = async (t: string, clauses: Clause[]) => {
  const r = await structured<{ items: Judgement[] }>('SONNET', JUDGE_SYSTEM, judgePrompt(t, clauses), 'submit_judgement', JUDGE_SCHEMA as unknown as Record<string, unknown>);
  return { items: r.value.items, model: r.model };
};

const sets = JSON.parse(readFileSync(join(dir, '../evaluations/cases/sets.json'), 'utf8')) as Record<string, string[]>;
const conflict5 = sets.knowhow_conflict_5!;
const cases: [string, string][] = [
  ...conflict5.map((id) => [id, 'CONFLICT'] as [string, string]),
  ['K-001', 'SUPPORTED'], ['K-003', 'OUTDATED'], ['K-004', 'INSUFFICIENT'],
  ...['G-KN-01', 'G-KN-02', 'G-KN-03', 'G-KN-04', 'G-KN-05'].map((id) => [id, 'NOT_CONFLICT'] as [string, string]),
];
const fileOf = (id: string) => (id.startsWith('G-') ? `golden/${id}.md` : `documents/${id}.md`);

const real = process.env.REAL === '1' ? await realDeps() : undefined;
console.log(`모드: ${real ? '실제 (규정 저장소·KB 검색)' : '임시 (fixture 파서·2-gram 검색)'}`);
let conflictHit = 0;
let falsePositive = 0;
let basisFp = 0;
const suggestions: string[] = [];
console.log('| 문서 | 기대 | 판정 | 결과 | 근거 |\n|---|---|---|---|---|');
for (const [id, expected] of cases) {
  const raw = read(fileOf(id)).replace(/^---\n[\s\S]*?\n---\n/, ''); // 작성자 선언 cites는 쓰지 않는다 (본문만)
  const text = mask(raw, detectPii(raw));
  const r = await validateKnowhow(text, real ?? { extractCitations, getClause: async (pid) => clauseIndex.get(pid), searchClauses, judge });
  const v = r.validation.verdict;
  const ok = expected === 'NOT_CONFLICT' ? v !== 'CONFLICT' : v === expected;
  if (conflict5.includes(id) && v === 'CONFLICT') conflictHit++;
  if (expected === 'NOT_CONFLICT' && v === 'CONFLICT') falsePositive++;
  const why = r.validation.items.find((j) => j.relation === 'CONFLICTS') ?? r.validation.items[0];
  const mis = r.findings.filter((f) => f.code === 'KNOWHOW_BASIS_MISMATCH').length; // 근거와 다름 (11/20, 원본 오탐 확인용)
  if (expected === 'NOT_CONFLICT' || expected === 'SUPPORTED') basisFp += mis;
  console.log(`| ${id} | ${expected} | ${v} | ${ok ? '✅' : '❌'} | ${why ? `${why.label}: ${why.reason}`.replace(/\|/g, '/').slice(0, 90) : r.validation.outdated[0]?.label ?? '-'}${mis ? ` · 근거와 다름 ${mis}` : ''} |`);
  if (process.env.SHOW_FIX) for (const j of r.validation.items.filter((x) => x.suggestion)) suggestions.push(`- ${id} [${j.relation}] "${j.statement}" → "${j.suggestion}"`);
}
if (suggestions.length) console.log(`\n수정 문장 (suggestion)\n${suggestions.join('\n')}`);
console.log(`\n노하우 충돌 탐지: ${conflictHit}/5 (기준 4/5 이상: ${conflictHit >= 4 ? '통과' : '미달'}) · 정상 노하우 오탐: ${falsePositive}/5 · 정상·일치 문서 근거와 다름 경고: ${basisFp}건`);
