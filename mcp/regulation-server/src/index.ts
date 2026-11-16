// Regulation MCP 서버 (AgentCore Gateway Lambda Target). 읽기 전용.
import { makeHandler } from "@hanaeum/mcp-kit";
import { DynamoClauseStore, DynamoLawPageCache } from "./store.ts";
import { regulationTools } from "./tools.ts";
import { AgentCoreLawFetcher, cachedFetcher } from "./browser.ts";

export * from "./store.ts";
export * from "./tools.ts";
export * from "./registry.ts";
export * from "./browser.ts";
export * from "./marks.ts";

const table = process.env["TABLE_REGULATIONS"];
export const handler = makeHandler(table ? regulationTools(new DynamoClauseStore(table), { fetcher: cachedFetcher(new AgentCoreLawFetcher(), new DynamoLawPageCache(table)) }) : {});
