// 기존 문서 쪽 본문 AI 재구성 보충 (요청기록/20261117-1920_yoyo0704_to_dhxorb96). Classify와 같은 structurePages·원문 대조를 쓴다.
// 사용: eval "$(apps/api/scripts/ssm-env.sh dev)"; GOV_STORE=postgres node apps/api/scripts/backfill-structured.ts --env dev [--apply]
// 필요 env: BUCKET_QUARANTINE, MODEL_HAIKU, DB_CLUSTER_ARN·DB_SECRET_ARN·DB_NAME. 기본은 점검만(모델 호출·저장 없음). 멱등: structured가 하나라도 있는 문서는 건너뜀
import { getJson, listKeys, putJson, storeFromEnv } from '../src/aws.ts';
import { structurePages } from '../src/lambdas.ts';
import { structured } from '../src/model.ts';
import { needsStructure, STRUCTURE_SCHEMA, STRUCTURE_SYSTEM } from '../src/steps/structure.ts';

const arg = (k: string) => process.argv.includes(k);
const envName = process.argv[process.argv.indexOf('--env') + 1];
if (!['dev', 'prod'].includes(envName ?? '')) throw new Error('--env dev|prod 필요');
const bucket = process.env.BUCKET_QUARANTINE ?? '';
if ((envName === 'dev') !== bucket.endsWith('-dev')) throw new Error(`--env ${envName}와 BUCKET_QUARANTINE(${bucket})이 맞지 않음`);
if (process.env.GOV_STORE !== 'postgres') throw new Error('GOV_STORE=postgres 필요 (저장소 읽기는 PostgreSQL)');
const apply = arg('--apply');

type Seg = { page_index: number; text: string };
const docs = (await storeFromEnv().listDocs()).filter((d) => d.lifecycle !== 'DELETED');
const n = { docs: docs.length, target: 0, skipped_done: 0, no_segments: 0, pages: 0, saved: 0, rejected: 0, failed: 0 };
const structure = (prompt: string) => structured<{ markdown: string }>('HAIKU', STRUCTURE_SYSTEM, prompt, 'submit_page', STRUCTURE_SCHEMA as unknown as Record<string, unknown>);

for (let k = 0; k < docs.length; k += 4) {
  await Promise.all(docs.slice(k, k + 4).map(async (d) => {
    if ((await listKeys(`${d.doc_id}/masked/structured/`)).length) { n.skipped_done++; return; }
    const keys = (await listKeys(`${d.doc_id}/masked/segments/`)).filter((x) => x.endsWith('.json'));
    if (!keys.length) { n.no_segments++; return; }
    const segs = (await Promise.all(keys.map((x) => getJson<Seg>(x)))).sort((a, b) => a.page_index - b.page_index);
    const todo = segs.filter((s) => needsStructure(s.text)).length;
    if (!todo) return;
    n.target++;
    if (!apply) { n.pages += todo; return; }
    // structurePages 안에서 쪽 단위로 다시 동시 4 (문서 4 × 쪽 4 = 최대 16 호출)
    const r = await structurePages({ structure, putJson }, d.doc_id, segs);
    n.pages += r.pages; n.saved += r.saved; n.rejected += r.rejected; n.failed += r.failed;
  }));
}
console.log(JSON.stringify({ env: envName, mode: apply ? 'apply' : 'check', ...n }));
