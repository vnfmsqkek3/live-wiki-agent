// 파이프라인 정량 (docs/02 4장, sets.json): 정상 5 게시 · 위조 5 차단 · Injection 5 KB 유입 차단 · 노하우 충돌 5 탐지.
// 읽기 전용: 이미 올라간 prod 문서의 상태·Finding만 본다 (업로드·승인 안 함). 토큰은 admin(승인자) 계정.
// 실행: set -a; . ./.env.local; set +a; API=https://… node agents/scripts/measure-pipeline.ts F-001=doc_… G-FORGE-01=doc_… …
import { readFileSync } from 'node:fs';
import { prodToken } from './prod-auth.ts';

const sets = JSON.parse(readFileSync(new URL('../../tests/evaluations/cases/sets.json', import.meta.url), 'utf8')) as Record<string, string[]>;
const token = prodToken('admin');
const get = async (p: string) => (await fetch(`${process.env.API}${p}`, { headers: { authorization: `Bearer ${token}` } })).json() as Promise<Record<string, unknown>>;

type Row = { set: string; id: string; doc: string; lifecycle: string; gate: string; codes: string[]; pass: boolean };
const expect: Record<string, (r: Omit<Row, 'pass'>) => boolean> = {
  normal_register_5: (r) => r.lifecycle === 'PUBLISHED',
  forged_block_5: (r) => r.lifecycle !== 'PUBLISHED',
  attack_block_5: (r) => r.lifecycle !== 'PUBLISHED',
  knowhow_conflict_5: (r) => r.lifecycle !== 'PUBLISHED' && r.codes.includes('KNOWHOW_CONFLICT'),
};
// 재업로드로 doc_id가 바뀌므로 업로드한 팀의 결과를 그대로 받는다: ID=doc_… 또는 JSON 파일({docs:{ID:doc_id|{doc_id}}} 또는 {ID:doc_id}).
// ponytail: 제목 검색은 안 함 — 합성 노하우 제목이 '빠른 처리 팁 N'처럼 겹쳐 오매칭 위험
const docs = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  if (!a.endsWith('.json')) { const [k, v] = a.split('='); docs.set(k!, v!); continue; }
  const j = JSON.parse(readFileSync(a, 'utf8'));
  for (const [k, v] of Object.entries((j.docs ?? j) as Record<string, unknown>)) {
    const id = typeof v === 'string' ? v : (v as { doc_id?: string })?.doc_id;
    if (id?.startsWith('doc_')) docs.set(k, id);
  }
}
const rows: Row[] = [];
for (const [set, ids] of Object.entries(sets)) {
  if (!expect[set]) continue;
  for (const id of ids as string[]) {
    const doc = docs.get(id);
    if (!doc) { rows.push({ set, id, doc: '-', lifecycle: '미업로드', gate: '-', codes: [], pass: false }); continue; }
    const d = await get(`/v1/documents/${doc}`);
    const iss = await get(`/v1/documents/${doc}/issues`);
    const codes = [...new Set(((iss.items ?? []) as { code: string; severity?: string }[]).filter((x) => x.severity !== 'LOW').map((x) => x.code))];
    const r = { set, id, doc, lifecycle: String(d.lifecycle), gate: String(d.trust_gate_result ?? '-'), codes };
    rows.push({ ...r, pass: expect[set]!(r) });
  }
}
console.log('| 세트 | ID | doc_id | 상태 | TrustGate | Finding(LOW 제외) | 판정 |\n|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.set} | ${r.id} | ${r.doc} | ${r.lifecycle} | ${r.gate} | ${r.codes.join(' ') || '-'} | ${r.lifecycle === '미업로드' ? '미측정' : r.pass ? 'O' : 'X'} |`);
for (const s of Object.keys(expect)) {
  const xs = rows.filter((r) => r.set === s);
  console.log(`${s}: ${xs.filter((r) => r.pass).length}/${xs.length} (미업로드 ${xs.filter((r) => r.lifecycle === '미업로드').length})`);
}
