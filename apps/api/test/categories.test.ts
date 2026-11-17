import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignCategory, type Choice } from '../src/categories.ts';

/** SQL 문을 보고 답하는 가짜 Data API. nearest 는 호출 순서대로 sims 를 쓴다 */
function fake(opts: { current?: string | null; nearest: { category_id: string; sim: number }[][]; choice: Choice }) {
  const log: string[] = [];
  let near = 0;
  const q = async (sql: string, p: Record<string, unknown> = {}) => {
    log.push(sql.split(/\s+/).slice(0, 3).join(' ') + (p.cat ? ` ${String(p.cat)}` : '') + (p.action ? ` ${String(p.action)}` : ''));
    if (sql.includes('embedding IS NULL')) return [];
    if (sql.includes('ORDER BY embedding')) return (opts.nearest[near++] ?? []).map((x) => ({ ...x, path: x.category_id, description: '', level: 2 }));
    if (sql.includes('level < 3')) return [{ category_id: 'cat_loan', path: '여신', level: 1 }];
    if (sql.includes('FOR UPDATE')) return [{ category_id: opts.current ?? null }];
    return [];
  };
  const deps = { q: q as never, tx: async <T>(fn: (q: never) => Promise<T>) => fn(q as never), embed: async () => [0.1, 0.2], choose: async () => ({ value: opts.choice, model: 'm' }) };
  return { deps, log };
}
const doc = { doc_id: 'doc_1', title: '전세자금대출 서류', summary: '요약' };

test('배정: 모르는 칸 id 는 가장 가까운 후보로, ASSIGN 기록·수 증가', async () => {
  const f = fake({ nearest: [[{ category_id: 'cat_retail', sim: 0.6 }, { category_id: 'cat_corp', sim: 0.5 }]], choice: { action: 'EXISTING', category_id: 'cat_none', reason: 'r' } });
  const r = await assignCategory(f.deps, doc);
  assert.deepEqual(r, { category_id: 'cat_retail', changed: true, created: false });
  assert.ok(f.log.some((l) => l.includes('ASSIGN')) && !f.log.some((l) => l.startsWith('INSERT INTO categories')));
});

test('새 칸 제안이 기존 칸과 0.85 이상 비슷하면 기존 칸, 아니면 AI 칸 생성(CREATE 기록)', async () => {
  const same = fake({ nearest: [[{ category_id: 'cat_retail', sim: 0.5 }], [{ category_id: 'cat_jeonse', sim: 0.91 }]], choice: { action: 'NEW', parent_id: 'cat_loan', name: '전세대출', description: 'd', reason: 'r' } });
  assert.equal((await assignCategory(same.deps, doc)).category_id, 'cat_jeonse');
  const fresh = fake({ nearest: [[{ category_id: 'cat_retail', sim: 0.5 }], [{ category_id: 'cat_retail', sim: 0.6 }]], choice: { action: 'NEW', parent_id: 'cat_loan', name: '전세대출', description: 'd', reason: 'r' } });
  const r = await assignCategory(fresh.deps, doc);
  assert.ok(r.category_id.startsWith('cat_') && 'created' in r && r.created);
  assert.ok(fresh.log.some((l) => l.startsWith('INSERT INTO categories')));
  assert.equal(fresh.log.filter((l) => l.startsWith('INSERT INTO category_events')).length, 2); // CREATE + ASSIGN
});

test('이미 같은 칸이면 아무 것도 바꾸지 않음 (멱등), 다른 칸이면 REASSIGN', async () => {
  const same = fake({ current: 'cat_retail', nearest: [[{ category_id: 'cat_retail', sim: 0.7 }]], choice: { action: 'EXISTING', category_id: 'cat_retail', reason: 'r' } });
  assert.deepEqual(await assignCategory(same.deps, doc), { category_id: 'cat_retail', changed: false });
  assert.ok(!same.log.some((l) => l.startsWith('UPDATE documents')));
  const move = fake({ current: 'cat_etc', nearest: [[{ category_id: 'cat_retail', sim: 0.7 }]], choice: { action: 'EXISTING', category_id: 'cat_retail', reason: 'r' } });
  await assignCategory(move.deps, doc);
  assert.ok(move.log.some((l) => l.includes('REASSIGN')) && move.log.some((l) => l.includes('GREATEST') || l.includes('cat_etc')));
});
