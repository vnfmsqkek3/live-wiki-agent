// 평가 실행기 (docs/05 5장 전체 결과표, 백엔드 PR #73 EVALUATION_RUN 계약). 사용법은 ../README.md
// 1) 오프라인 measure.ts  2) 실환경 measure-kb.ts(prod KB·검색 Lambda)  3) 결과표 출력  4) S3 evaluations/{at}.json + 감사 기록
// ponytail: Golden 질의별 AgentCore Trace 수집은 아직 없음(측정 스크립트가 도구를 직접 부름). Evaluations 연결(P1) 때 trace_id 를 채운다
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse, type Failure, type Item } from "./parse.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const dry = process.argv.includes("--dry-run"), offlineOnly = process.argv.includes("--offline");
const env = "prod"; // 사용자 결정 11/20: prod 단일 환경
const run = (script: string) => {
  // 측정이 미달이어도 표는 나온다. 실행 자체가 실패하면 그 묶음은 실패 1건으로 남긴다
  try { return execFileSync("node", [`tests/evaluations/cases/src/${script}`], { cwd: root, env: { ...process.env, HANAEUM_ENV: env }, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 30 * 60_000 }); }
  catch (e) { return `  ${script} 실행 실패: ${String((e as Error).message).split("\n")[0]}`; }
};

const offline = parse(run("measure.ts"), "offline");
const live = offlineOnly ? { items: [] as Item[], failures: [] as Failure[] } : parse(run("measure-kb.ts"), "live");
// 같은 항목은 실환경 결과가 기준 (오프라인은 실환경이 없는 항목만: 파싱·영향)
const liveKeys = new Set(live.items.map((i) => i.key));
// --extra <json>: 실행기가 직접 못 재는 다른 팀 측정값 [{key,label,target,passed,total,measured_by,measured_at}] (정상 등록·위조·Injection·충돌·비인가 게시)
const xi = process.argv.indexOf("--extra");
const extra: Item[] = xi < 0 ? [] : (JSON.parse(readFileSync(process.argv[xi + 1]!, "utf8")) as (Item & { measured_by?: string; measured_at?: string })[]).map((e) => {
  if (!e.key || !e.label || !Number.isInteger(e.passed) || !Number.isInteger(e.total) || e.total < 1) throw new Error(`--extra 항목 형식: ${JSON.stringify(e)}`);
  return { key: e.key, label: e.label, target: e.target, passed: e.passed, total: e.total, pass: e.pass ?? e.passed === e.total };
});
const items = [...offline.items.filter((i) => !liveKeys.has(i.key)), ...live.items, ...extra];
const failures = [...offline.failures.filter((f) => !liveKeys.has(f.key)), ...live.failures].slice(0, 100);
const at = new Date().toISOString(), trace_id = randomUUID();

console.log(`| 항목 | 목표 | 결과 | 판정 |\n|---|---|---|---|`);
for (const i of items) console.log(`| ${i.label} | ${i.target} | ${i.passed}/${i.total} | ${i.pass ? "통과" : "미달"} |`);
for (const f of failures) console.log(`  [${f.key}] ${f.reason}`);
console.log(`전체 ${items.filter((i) => i.pass).length}/${items.length} 통과, 실패 ${failures.length}건 (${at})`);

if (!dry) {
  const ssm = (n: string) => execFileSync("aws", ["ssm", "get-parameter", "--name", `/hanaeum-mvp/${env}/${n}`, "--query", "Parameter.Value", "--output", "text"], { encoding: "utf8" }).trim();
  const detail = { items, failures };
  execFileSync("aws", ["s3", "cp", "-", `s3://${ssm("BUCKET_ARTIFACT")}/evaluations/${at}.json`, "--content-type", "application/json"], { input: JSON.stringify({ at, trace_id, env, ...detail }) });
  const { db } = await import("@hanaeum/db");
  await db({ resourceArn: ssm("DB_CLUSTER_ARN"), secretArn: ssm("DB_SECRET_ARN"), database: ssm("DB_NAME") }).query(
    "INSERT INTO audit_events (at, actor, action, resource, result, trace_id, detail) VALUES (:at::timestamptz, 'system:evaluations', 'EVALUATION_RUN', 'evaluations', 'OK', :trace_id, :detail::jsonb)",
    { at, trace_id, detail: JSON.stringify(detail) });
  console.log(`저장: s3 evaluations/${at}.json, 감사 EVALUATION_RUN ${trace_id}`);
}
