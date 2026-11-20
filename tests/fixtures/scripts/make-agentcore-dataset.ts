// AgentCore Evaluations 정답 데이터셋 (P1, 총괄 11/20): 평가 케이스(tests/evaluations/cases, 데이터QA) + Registry 조문 원문(fixture) →
// AgentCore dataset JSON (https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/dataset-evaluations-schema.html)
//   { scenarios: [{ scenario_id, turns: [{ input, expected_response }], expected_trajectory?, assertions?, metadata? }] }
//   Builtin.Correctness ← turns[].expected_response, Builtin.GoalSuccessRate ← assertions.
//   expected_trajectory 는 넣지 않음: 1차 검색(search_wiki)은 Agent 밖 코드 호출이라 Agent span 에 안 찍힐 수 있음(AI팀 11/20) → metadata.expected_tools 참고용
// 실행: node tests/fixtures/scripts/make-agentcore-dataset.ts  → tests/fixtures/evaluations/agentcore-dataset.json
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fixtureClauseStore } from "../../../mcp/regulation-server/src/fixtures.ts";

const CASES = new URL("../../evaluations/cases/", import.meta.url);
const jsonl = <T>(f: string) => readFileSync(new URL(f, CASES), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
const store = fixtureClauseStore();

/** provision_id → "하나은행 기업여신 심사규정 제12조제1항 (2026-12-01 시행)" + 원문 */
async function clause(pid: string) {
  const [law, rest] = pid.split("@") as [string, string];
  const rev = rest.split("/")[0]!;
  const r = (await store.revisions(law)).find((x) => x.revision_id === rev);
  const p = ((await store.provisions(law, rev)) ?? []).find((x) => x.provision_id === pid);
  if (!r || !p) throw new Error(`fixture 에 없는 조문: ${pid}`);
  return { label: `${r.law_name} ${p.path_label}`, rev, text: p.normalized_text };
}

/** Agent 는 기준일을 말하지 않으면 오늘로 답한다 → 케이스 기준일을 질문에 넣는다 (정답이 그 기준일의 시행 버전) */
const ask = (q: string, asOf: string) => `${asOf.replace(/^(\d{4})-(\d{2})-(\d{2})$/u, (_, y, m, d) => `${y}년 ${Number(m)}월 ${Number(d)}일`)} 기준으로 답해 주세요. ${q}`;
type Scenario = { scenario_id: string; turns: { input: string; expected_response?: string }[]; expected_trajectory?: string[]; assertions?: string[]; metadata?: Record<string, unknown> };
const scenarios: Scenario[] = [];

// 근거 인용: 질문 → 현행 조문을 근거로 답 (금지 근거 = 삭제·과거·위조 조문)
for (const c of jsonl<{ id: string; question: string; as_of: string; expected_provision_ids: string[]; forbidden_provision_ids?: string[] }>("citation.jsonl")) {
  const exp = await Promise.all(c.expected_provision_ids.map(clause));
  const forb = await Promise.all((c.forbidden_provision_ids ?? []).map(clause));
  scenarios.push({
    scenario_id: c.id,
    turns: [{ input: ask(c.question, c.as_of), expected_response: exp.map((e) => `${e.label}(${e.rev} 시행): ${e.text}`).join("\n") }],
    assertions: [
      ...exp.map((e) => `답변이 ${e.label}(${e.rev} 시행)을 근거로 인용한다`),
      ...forb.map((f) => `답변이 ${f.label}(${f.rev} 시행분, 현행 아님)을 현행 근거로 인용하지 않는다`),
    ],
    metadata: { kind: "citation", as_of: c.as_of, expected_tools: ["search___search_wiki"], expected_provision_ids: c.expected_provision_ids, forbidden_provision_ids: c.forbidden_provision_ids ?? [] },
  });
}

// 정확 조문 조회: 조문 번호를 지정한 질문 → 그 조문 원문, 삭제·과거면 그 상태를 밝힘
for (const c of jsonl<{ id: string; query: string; as_of: string; expected_status: string; expected_provision_id?: string; expected_text?: string }>("clause_lookup.jsonl")) {
  const e = c.expected_provision_id ? await clause(c.expected_provision_id).catch(() => undefined) : undefined;
  scenarios.push({
    scenario_id: c.id,
    turns: [{ input: ask(c.query, c.as_of), ...(e ? { expected_response: `${e.label}(${e.rev} 시행): ${e.text}` } : {}) }],
    assertions: [
      c.expected_status === "FOUND" && e ? `답변이 ${e.label} 원문을 인용한다${c.expected_text ? ` (핵심: "${c.expected_text}")` : ""}` :
      c.expected_status === "DELETED" ? "답변이 해당 조문이 삭제되었음을 밝히고 삭제 전 내용을 현행처럼 안내하지 않는다" :
      c.expected_status === "HISTORICAL" ? "답변이 해당 조문이 기준일에 시행 중이 아닌 과거 버전임을 밝힌다" :
      "답변이 조문을 확인하지 못했다고 밝히고 조문이 없다고 단정하지 않는다",
    ],
    metadata: { kind: "clause_lookup", as_of: c.as_of, expected_tools: ["search___search_legal_clause"], expected_status: c.expected_status, expected_provision_id: c.expected_provision_id ?? null },
  });
}

// 검색 실패 판정: 근거가 없거나 불확실 → 부재 단정·무관 근거 제시 금지
for (const c of jsonl<{ id: string; tool: string; query: string; as_of: string; why: string }>("unverified.jsonl")) {
  scenarios.push({
    scenario_id: c.id,
    turns: [{ input: ask(c.query, c.as_of) }],
    assertions: ["답변이 근거를 확인하지 못했다고 밝힌다", "답변이 해당 조문·규정이 존재하지 않는다고 단정하지 않는다", "답변이 질문과 무관한 조문을 근거로 제시하지 않는다"],
    metadata: { kind: "unverified", as_of: c.as_of, expected_tools: [`search___${c.tool}`], why: c.why },
  });
}

const out = new URL("../evaluations/agentcore-dataset.json", import.meta.url);
mkdirSync(new URL(".", out), { recursive: true });
writeFileSync(out, JSON.stringify({ scenarios }, null, 2) + "\n");
console.log("scenarios", scenarios.length, Object.entries(scenarios.reduce<Record<string, number>>((a, s) => ((a[String(s.metadata?.["kind"])] = (a[String(s.metadata?.["kind"])] ?? 0) + 1), a), {})));
