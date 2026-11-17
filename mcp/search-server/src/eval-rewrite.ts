// 질의 재구성 실측 (읽기 전용, 운영자 시점 필터). 실행: set -a; . ./.env.local; set +a; KB_ID=… MODEL_RERANK=… MODEL_HAIKU=… node mcp/search-server/src/eval-rewrite.ts
// 원문 질의 그대로 vs 재구성 질의의 1위 문서·점수를 비교하고, 무관 질의가 게이트를 통과하는지·alternates가 주제를 벗어나는지 본다.
import { readFileSync } from "node:fs";
import { maskPii } from "@hanaeum/mcp-kit";
import { BedrockRetriever, buildFilter, retrieveMany, RERANK_TOP1_MIN } from "./search.ts";
import { BedrockRewriter, cleanQuery } from "./rewrite.ts";

const e = process.env;
const r = new BedrockRetriever(e["KB_ID"]!, e["MODEL_RERANK"]);
const rw = new BedrockRewriter(e["MODEL_HAIKU"]!);
const f = buildFilter({ sub: "eval", groups: ["USER", "AUTHOR"], dept: "여신" }, { asOf: 20261231, indexGroups: ["legal-clauses", "wiki-knowledge"] });
const cases = readFileSync(new URL("../../../tests/evaluations/cases/query_rewrite.jsonl", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { id: string; query: string; expect: string | null });
type H = { score: number; weak?: boolean; metadata: Record<string, unknown>; matched_query?: string };
// 근거 기준 통과(게이트) 결과의 제목들(1위 먼저). 기대 문서가 그 안에 있으면 정답 (노하우가 1위여도 규정이 함께 나오면 정답)
const top = (h: H[]) => {
  const ok = h.filter((x) => !x.weak);
  return { titles: ok.map((x) => String(x.metadata["title"] ?? "")), title: String(ok[0]?.metadata["title"] ?? ""), score: (ok[0] ?? h[0])?.score ?? 0, q: (ok[0] ?? h[0])?.matched_query };
};
let okBefore = 0, okAfter = 0, fp = 0;
for (const c of cases) {
  const q = maskPii(c.query).text;
  const before = top(await r.retrieve(q, f));
  const w = await rw.rewrite(q);
  const after = top(await retrieveMany(r, [q, cleanQuery(q), w.core], w.alternates, f)); // search.ts run()과 같은 후보
  const pass = (t: { titles: string[] }) => (c.expect ? t.titles.some((x) => new RegExp(c.expect!, "u").test(x)) : !t.titles.length);
  okBefore += +pass(before); okAfter += +pass(after); if (!c.expect && after.titles.length) fp++;
  console.log([c.id, pass(before) ? "O" : "X", before.score.toFixed(3), "→", pass(after) ? "O" : "X", after.score.toFixed(3),
    JSON.stringify(w.core), JSON.stringify(w.alternates), "by", JSON.stringify(after.q ?? ""), after.title.replace("[SYNTHETIC] ", "")].join(" "));
}
const n = cases.length;
console.log(`게이트 ${RERANK_TOP1_MIN} | 정답(원문) ${okBefore}/${n} → 정답(재구성) ${okAfter}/${n} | 무관 질의 통과(오탐) ${fp}/${cases.filter((c) => !c.expect).length}`);
