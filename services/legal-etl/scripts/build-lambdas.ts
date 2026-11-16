// let522mj 소유 Lambda 번들 (esbuild, nodejs24.x, arm64 무관 순수 JS). 결과: dist/lambda/{name}.zip, 핸들러 = index.handler
// 실행: node services/legal-etl/scripts/build-lambdas.ts
// nodejs24.x 런타임은 .ts를 못 읽으므로 번들 필수 (트러블슈팅 11/16 dhxorb96). AWS SDK도 번들해 버전 고정.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const OUT = `${ROOT}dist/lambda/`;

/** Terraform step_functions 키(workflows/src/asl.ts)와 같은 이름 + MCP·KB Lambda */
export const LAMBDAS: Record<string, { file: string; exportName: string; env: string[] }> = {
  text_layer_extract: { file: "services/legal-etl/src/index.ts", exportName: "textLayerHandler", env: [] },
  segment_build: { file: "services/legal-etl/src/index.ts", exportName: "segmentHandler", env: [] },
  promote: { file: "services/legal-etl/src/index.ts", exportName: "promoteHandler", env: ["BUCKET_PUBLISHED", "TABLE_DOCUMENTS", "TABLE_APPROVALS"] },
  kb_ingest: { file: "services/legal-etl/src/index.ts", exportName: "kbIngestHandler", env: ["KB_ID", "KB_DS_LEGAL_ID", "KB_DS_KNOWLEDGE_ID", "BUCKET_ARTIFACT", "TABLE_DOCUMENTS", "TABLE_APPROVALS"] },
  graph_upsert: { file: "mcp/graph-server/src/index.ts", exportName: "graphUpsertHandler", env: ["NEPTUNE_ENDPOINT", "TABLE_REGULATIONS", "TABLE_DOCUMENTS", "TABLE_APPROVALS", "BUCKET_PUBLISHED"] },
  kb_chunker: { file: "services/kb-chunker/src/index.ts", exportName: "handler", env: [] },
  mcp_regulation: { file: "mcp/regulation-server/src/index.ts", exportName: "handler", env: ["TABLE_REGULATIONS"] },
  mcp_search: { file: "mcp/search-server/src/index.ts", exportName: "handler", env: ["KB_ID", "MODEL_RERANK", "TABLE_DOCUMENTS", "TABLE_REGULATIONS"] },
  mcp_graph: { file: "mcp/graph-server/src/index.ts", exportName: "handler", env: ["NEPTUNE_ENDPOINT", "TABLE_REGULATIONS"] },
};

if (import.meta.main) {
  rmSync(OUT, { recursive: true, force: true });
  for (const [name, l] of Object.entries(LAMBDAS)) {
    const dir = `${OUT}${name}/`;
    mkdirSync(dir, { recursive: true });
    await build({
      stdin: { contents: `export { ${l.exportName} as handler } from ${JSON.stringify(ROOT + l.file)};`, resolveDir: ROOT, loader: "ts" },
      bundle: true, platform: "node", target: "node24", format: "esm", outfile: `${dir}index.mjs`, minify: true, legalComments: "none",
      // ESM 번들 안의 CJS 의존성(require) 지원
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
      logLevel: "warning",
    });
    execFileSync("zip", ["-qj", `${OUT}${name}.zip`, `${dir}index.mjs`]);
    console.log(name, `${l.file}#${l.exportName}`, "env:", l.env.join(",") || "-");
  }
}
