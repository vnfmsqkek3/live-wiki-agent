// 실 DynamoDB(Regulations) 대상 정확 조문 검색 측정. 법령 조회 경로(Exact Lookup)만 — KB 경로는 색인 후 별도.
// 실행: TABLE_REGULATIONS=… node tests/evaluations/cases/src/measure-live.ts
import { readFileSync } from "node:fs";
import { DynamoClauseStore, regulationTools, clausePath } from "@hanaeum/regulation-server";
import { EVAL_TODAY } from "./measure.ts";

const cases = readFileSync(new URL("../clause_lookup.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const t = regulationTools(new DynamoClauseStore(process.env["TABLE_REGULATIONS"]!), { today: () => EVAL_TODAY });
const user = { sub: "eval", groups: ["USER"] };
let ok = 0;
for (const c of cases) {
  const m = c.query.match(/^(.*?)\s*((?:부칙\s*)?제\s*\d+\s*조(?:\s*의\s*\d+)?(?:\s*제\s*\d+\s*항)?(?:\s*제\s*\d+\s*호(?:\s*의\s*\d+)?)?)/u);
  const r = await t.get_clause({ law: m[1].trim(), clause: m[2], as_of: c.as_of }, user);
  const pass = r.search_status === c.expected_status && (!c.expected_provision_id || r.provision_id === c.expected_provision_id) && (!c.expected_text || r.original_text?.includes(c.expected_text));
  if (pass) ok++; else console.log("FAIL", c.id, r.search_status, r.provision_id, "expected", c.expected_status, c.expected_provision_id, clausePath(m[2]));
}
console.log(`실 DynamoDB 정확 조문 조회 ${ok}/${cases.length}`);
