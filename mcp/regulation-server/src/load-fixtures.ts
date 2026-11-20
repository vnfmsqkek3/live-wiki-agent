// 합성 Registry 규정을 Regulations 테이블(Owner let522mj)에 적재. 공유 dev 실연동 확인용.
// 실행: TABLE_REGULATIONS=hanaeum-mvp-ddb-regulations node mcp/regulation-server/src/load-fixtures.ts  [PROVISIONS_ONLY=1]
import { DynamoClauseStore } from "./store.ts";
import { fixtureClauseStore } from "./fixtures.ts";

const table = process.env["TABLE_REGULATIONS"];
if (!table) throw new Error("TABLE_REGULATIONS 필요");
const src = fixtureClauseStore();
const dst = new DynamoClauseStore(table);
for (const r of src.revs) {
  const provisions = (await src.provisions(r.law_id, r.revision_id))!;
  // PROVISIONS_ONLY=1: 조문 원문만 Registry 것으로 되돌리고 개정본 기록(게시 doc_id·종료일 등)은 지금 값 유지 (prod 11/20: 게시본 OCR이 덮어쓴 원문 복구)
  const cur = process.env["PROVISIONS_ONLY"] ? (await dst.revisions(r.law_id)).find((x) => x.revision_id === r.revision_id) : undefined;
  if (process.env["PROVISIONS_ONLY"] && !cur) { console.log("skip(미적재)", `${r.law_id}@${r.revision_id}`); continue; }
  await dst.putLaw(cur ?? r, { law_id: r.law_id, law_name: r.law_name, revision_id: r.revision_id, effective_from: r.effective_from, parser_version: "", provisions, issues: [] });
  console.log("loaded", `${r.law_id}@${r.revision_id}`, provisions.length);
}
