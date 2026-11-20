// 외부 법령 대조 로컬 실측 (총괄 지시 11/20): MX-002·MX-003 바꾼 4곳 탐지 + 수정 제안, M-002·M-003 오탐 0.
// 실제 모델(MODEL_SONNET 판정·MODEL_HAIKU 수정 제안) + AgentCore Browser 로 law.go.kr 원문. 결과는 표로 출력.
// 실행: set -a; . ./.env.local; set +a; MODEL_SONNET=… MODEL_HAIKU=… node agents/scripts/measure-external.ts
import { readFileSync } from 'node:fs';
import { detectPii, mask } from '@hanaeum/pii';
import { AgentCoreLawFetcher, externalLawRefs, fetchOfficialLaw } from '../../mcp/regulation-server/src/browser.ts';
import { JUDGE_SCHEMA, JUDGE_SYSTEM, judgePrompt, SUGGEST_SCHEMA, SUGGEST_SYSTEM, suggestPrompt, validateExternal, type Judgement } from '../../apps/api/src/steps/knowhow.ts';
import { structured } from '../../apps/api/src/model.ts';

const FIX = new URL('../../tests/fixtures/documents/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', FIX), 'utf8')) as { user_documents: { document_id: string; file: string; changes?: { before: string; after: string; basis: string }[] }[] };
// 내부 규정 저장소 없음 = 전부 외부 법령으로 본다 (외국환거래규정은 Registry 에 없음)
const store = { lawIdByName: async () => undefined } as never;
const fetcher = new AgentCoreLawFetcher();
const pages = new Map<string, ReturnType<typeof fetcher.fetch>>(); // 같은 법령 쪽은 한 번만 연다
const cached = { fetch: (n: string) => { if (!pages.has(n)) pages.set(n, fetcher.fetch(n)); return pages.get(n)!; } };

const deps = {
  judge: async (t: string, cl: Parameters<typeof judgePrompt>[1]) => ({ items: (await structured<{ items: Judgement[] }>('SONNET', JUDGE_SYSTEM, judgePrompt(t, cl), 'submit_judgement', JUDGE_SCHEMA as never)).value.items, model: '' }),
  suggest: async (items: Parameters<typeof suggestPrompt>[0]) => (await structured<{ suggestions: string[] }>('HAIKU', SUGGEST_SYSTEM, suggestPrompt(items), 'submit_suggestions', SUGGEST_SCHEMA as never)).value.suggestions,
  external: {
    // 조문마다 하나씩 (externalLawRefs.clause 는 첫 조문뿐)
    findLaws: async (t: string) => (await externalLawRefs(t, store)).flatMap((r) => r.clauses.map((clause) => ({ law_name: r.law_name, clause }))),
    fetchLaw: async (r: { law_name: string; clause: string }) => fetchOfficialLaw(cached, store, r),
    timeoutMs: 180_000, // 로컬 첫 Browser 세션은 느리다. 운영 상한 60초는 단위 테스트로 확인
  },
};

const num = (s: string) => s.match(/\d+(?:[.,]\d+)?/g) ?? [];
let missed = 0; let fp = 0;
for (const id of (process.env.ONLY?.split(',') ?? ['M-002', 'M-003', 'MX-002', 'MX-003'])) {
  const doc = manifest.user_documents.find((d) => d.document_id === id)!;
  const raw = readFileSync(new URL(doc.file.replace(/^documents\//, ''), FIX), 'utf8').replace(/^---[\s\S]*?---\n/, '');
  const text = mask(raw, detectPii(raw));
  const r = await validateExternal(text, deps);
  const mism = r.findings.filter((f) => f.code === 'KNOWHOW_EXTERNAL_MISMATCH');
  console.log(`\n## ${id} — 불일치 ${mism.length}건, 생략 ${r.findings.filter((f) => f.code === 'KNOWHOW_EXTERNAL_SKIPPED').map((f) => f.message).join(' ') || '없음'}`);
  if (process.env.DEBUG) for (const j of r.external) console.log(`  · ${j.relation}${j.verified_quote ? '' : '(인용 미확인)'} ${j.provision_id} | ${j.statement.slice(0, 60)} | ${j.quote.slice(0, 60)}`);
  for (const f of mism) console.log(`- [${f.evidence_ref}] ${f.location?.excerpt}\n  사유: ${f.message}\n  제안: ${f.fix_hint}`);
  if (!doc.changes) { fp += mism.length; continue; }
  // 바꾼 곳: 그 문장(바뀐 숫자·단어)을 가리키는 불일치가 있으면 탐지. 판정은 사람이 출력으로 다시 확인
  for (const c of doc.changes) {
    const key = num(c.after).filter((n) => !num(c.before).includes(n));
    const words = key.length ? key : ['여신최다은행', '주채권은행'];
    const hit = mism.some((f) => words.some((w) => (f.location?.excerpt ?? '').includes(w) || f.message.includes(w)));
    if (!hit) missed++;
    console.log(`  ${hit ? 'O' : 'X'} 바꾼 곳: ${c.after} (${c.basis})`);
  }
}
console.log(`\n결과: 바꾼 곳 놓침 ${missed}/4, 원본 오탐 ${fp}건`);
