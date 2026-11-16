// 실 KB Retrieve 계약 확인용 (읽기 전용). 실행: KB_ID=… MODEL_RERANK_ARN=… node mcp/search-server/src/probe-kb.ts
import { BedrockRetriever, buildFilter } from "./search.ts";
const kb = process.env["KB_ID"]!;
const actor = { sub: "probe", groups: ["USER", "AUTHOR"], dept: "여신" };
const f = buildFilter(actor, { asOf: 20261215, indexGroups: ["legal-clauses", "wiki-knowledge"] });
for (const [name, r] of [["hybrid", new BedrockRetriever(kb)], ["hybrid+rerank", new BedrockRetriever(kb, process.env["MODEL_RERANK_ARN"])]] as const) {
  try { const hits = await r.retrieve("본부 여신심사위원회 승인 기준", f); console.log(name, "OK hits=", hits.length, hits.slice(0, 2).map((h) => h.metadata["doc_id"])); }
  catch (e) { console.log(name, "ERR", (e as Error).name, (e as Error).message.slice(0, 300)); }
}
