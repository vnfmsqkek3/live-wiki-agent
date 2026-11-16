// Search MCP 서버 (AgentCore Gateway Lambda Target)
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { makeHandler } from "@hanaeum/mcp-kit";
import { DynamoClauseStore, regulationTools } from "@hanaeum/regulation-server";
import { BedrockRetriever, searchTools } from "./search.ts";
import type { DocState, DocStates } from "./search.ts";

export * from "./search.ts";

export class DynamoDocStates implements DocStates {
  private readonly db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  private readonly table: string;
  constructor(table: string) { this.table = table; }
  async get(ids: string[]) {
    const out = new Map<string, DocState>();
    for (let i = 0; i < ids.length; i += 100) {
      let keys: Record<string, unknown>[] | undefined = ids.slice(i, i + 100).map((doc_id) => ({ doc_id }));
      for (let attempt = 0; keys?.length; attempt++) {
        if (attempt > 5) throw new Error("BatchGet 미처리 키 재시도 초과");
        const r: import("@aws-sdk/lib-dynamodb").BatchGetCommandOutput = await this.db.send(new BatchGetCommand({ RequestItems: { [this.table]: { Keys: keys, ProjectionExpression: "doc_id, lifecycle, authority_status, conditional, freshness, acl_groups, content_hash, effective_from, effective_to" } } }));
        for (const it of r.Responses?.[this.table] ?? []) out.set(String(it["doc_id"]), it as DocState);
        keys = r.UnprocessedKeys?.[this.table]?.Keys;
        if (keys?.length) await new Promise((res) => setTimeout(res, 100 * 2 ** attempt));
      }
    }
    return out;
  }
}

const e = process.env;
export const handler = makeHandler(e["KB_ID"] && e["TABLE_DOCUMENTS"] && e["TABLE_REGULATIONS"]
  ? searchTools({
    retriever: new BedrockRetriever(e["KB_ID"], e["MODEL_RERANK"]),
    states: new DynamoDocStates(e["TABLE_DOCUMENTS"]),
    regulation: regulationTools(new DynamoClauseStore(e["TABLE_REGULATIONS"])),
  })
  : {});
export * from "./memory.ts";
