// Graph MCP 서버 + 단계 13 GraphUpsert
import { makeHandler } from "@hanaeum/mcp-kit";
import { S3ObjectStore } from "@hanaeum/legal-etl";
import { DynamoClauseStore } from "@hanaeum/regulation-server";
import { NeptuneGraphStore } from "./store.ts";
import { graphTools } from "./tools.ts";
import { graphUpsertStep } from "./upsert-step.ts";
import type { GraphUpsertInput } from "./upsert-step.ts";

export * from "./model.ts";
export * from "./store.ts";
export * from "./impact.ts";
export * from "./citations.ts";
export * from "./tools.ts";
export * from "./upsert-step.ts";

const e = process.env;
const deps = () => ({ graph: new NeptuneGraphStore(e["NEPTUNE_ENDPOINT"]!), clauses: new DynamoClauseStore(e["TABLE_REGULATIONS"]!) });
export const handler = makeHandler(e["NEPTUNE_ENDPOINT"] && e["TABLE_REGULATIONS"] ? graphTools(deps()) : {});
// 본문은 SFN 페이로드(256KB 제한)로 넘기지 않고 Promote 출력 키로 published 버킷에서 읽는다
export const graphUpsertHandler = async (input: Omit<GraphUpsertInput, "content"> & { published_key: string }) => {
  const content = (await new S3ObjectStore().get(e["BUCKET_PUBLISHED"]!, input.published_key)).toString("utf8");
  const d = deps();
  return graphUpsertStep({ ...input, content }, d.graph, d.clauses);
};
