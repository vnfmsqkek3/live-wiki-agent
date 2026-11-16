// 합성 Registry 규정을 Regulations 테이블(Owner let522mj)에 적재. 공유 dev 실연동 확인용.
// 실행: TABLE_REGULATIONS=hanaeum-mvp-ddb-regulations-dev node mcp/regulation-server/src/load-fixtures.ts
import { DynamoClauseStore } from "./store.ts";
import { fixtureClauseStore } from "./fixtures.ts";

const table = process.env["TABLE_REGULATIONS"];
if (!table) throw new Error("TABLE_REGULATIONS 필요");
const src = fixtureClauseStore();
const dst = new DynamoClauseStore(table);
for (const r of src.revs) {
  const provisions = (await src.provisions(r.law_id, r.revision_id))!;
  await dst.putLaw(r, { law_id: r.law_id, law_name: r.law_name, revision_id: r.revision_id, effective_from: r.effective_from, parser_version: "", provisions, issues: [] });
  console.log("loaded", `${r.law_id}@${r.revision_id}`, provisions.length);
}
