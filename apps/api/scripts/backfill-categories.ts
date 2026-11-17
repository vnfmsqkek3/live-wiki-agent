// 기존 문서 업무 분류 보충 (요청기록/20261117-2210, interfaces.md 10.1). Classify 와 같은 assignCategory 를 쓴다.
// 사용: eval "$(apps/api/scripts/ssm-env.sh dev)"; GOV_STORE=postgres node apps/api/scripts/backfill-categories.ts --env dev [--apply] [--limit N] [--all]
// 필요 env: DB_*, MODEL_EMBED, MODEL_HAIKU. 기본은 점검만(대상 수만). 멱등: 칸이 이미 있는 문서는 건너뜀(--all 이면 다시 배정, 같은 칸이면 변경 없음)
import { db } from '@hanaeum/db';
import { assignCategory, CHOOSE_SCHEMA, CHOOSE_SYSTEM, type Choice } from '../src/categories.ts';
import { embed, structured } from '../src/model.ts';

const arg = (k: string) => process.argv.includes(k);
const val = (k: string) => process.argv[process.argv.indexOf(k) + 1];
const envName = val('--env');
if (!['dev', 'prod'].includes(envName ?? '')) throw new Error('--env dev|prod 필요');
if ((envName === 'dev') !== (process.env.DB_CLUSTER_ARN ?? '').includes('-dev')) throw new Error(`--env ${envName}와 DB_CLUSTER_ARN이 맞지 않음`);
const limit = Number(val('--limit') ?? 0) || Infinity;

const d = db();
const docs = await d.query<{ doc_id: string; title: string; summary: string | null; category_id: string | null }>(
  `SELECT doc_id, title, attrs->>'summary' AS summary, category_id FROM documents WHERE lifecycle NOT IN ('DELETED', 'BLOCKED') ${arg('--all') ? '' : 'AND category_id IS NULL'} ORDER BY created_at`);
const todo = docs.slice(0, limit);
const n = { target: todo.length, assigned: 0, unchanged: 0, created: 0, failed: 0 };
if (arg('--apply')) {
  const deps = { q: d.query, tx: d.tx, embed, choose: (p: string) => structured<Choice>('HAIKU', CHOOSE_SYSTEM, p, 'submit_category', CHOOSE_SCHEMA as unknown as Record<string, unknown>) };
  // ponytail: 한 건씩 (새 칸을 만든 직후 다음 문서가 그 칸을 후보로 볼 수 있게). 수백 건 전까지 충분
  for (const doc of todo) {
    try {
      const r = await assignCategory(deps, { doc_id: doc.doc_id, title: doc.title, summary: doc.summary ?? undefined }, 'AI:backfill');
      if (r.changed) n.assigned++; else n.unchanged++;
      if ('created' in r && r.created) n.created++;
    } catch (e) { n.failed++; console.warn(JSON.stringify({ msg: 'category failed', doc_id: doc.doc_id, err: (e as Error).name, m: (e as Error).message.slice(0, 120) })); }
  }
}
console.log(JSON.stringify({ env: envName, mode: arg('--apply') ? 'apply' : 'check', ...n }));
