// Search MCP 서버 (AgentCore Gateway Lambda Target)
import { db } from "@hanaeum/db";
import type { Query } from "@hanaeum/db";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { makeHandler } from "@hanaeum/mcp-kit";
import { DynamoClauseStore, regulationTools } from "@hanaeum/regulation-server";
import { BedrockRetriever, searchTools } from "./search.ts";
import { BedrockRewriter } from "./rewrite.ts";
import type { DocState, DocStates, PublishedReader } from "./search.ts";

/** published 버킷의 게시본 (규정 legal/, 그 밖 knowledge/). 권한: s3:GetObject on {legal,knowledge}/* 만 */
export class S3Published implements PublishedReader {
  private readonly s3 = new S3Client({});
  private readonly bucket: string;
  constructor(bucket: string) { this.bucket = bucket; }
  private async text(key: string) {
    try { return await (await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))).Body!.transformToString("utf-8"); }
    catch (e) { if ((e as Error).name === "NoSuchKey") return undefined; throw e; } // 권한 오류는 숨기지 않음 (설정 실수가 "없음"으로 보이지 않게)
  }
  async get(doc_id: string, document_type?: string) {
    // 위치 규칙은 Promote publishedPrefix와 같음 (규정 legal/, 그 밖 knowledge/)
    const p = `${document_type === "REGULATION" ? "legal" : "knowledge"}/${doc_id}/content.txt`;
    const content = await this.text(p);
    const side = content === undefined ? undefined : await this.text(`${p}.metadata.json`);
    return content === undefined || !side ? undefined : { content, meta: (JSON.parse(side) as { metadataAttributes: Record<string, unknown> }).metadataAttributes };
  }
}

export * from "./search.ts";
export * from "./rewrite.ts";

/** 거버넌스 저장소 PostgreSQL (GOV_STORE=postgres, interfaces.md 10장). 시행일·조건부는 attrs(jsonb) */
export class PgDocStates implements DocStates {
  private readonly q: Query;
  constructor(q: Query) { this.q = q; }
  async get(ids: string[]) {
    const out = new Map<string, DocState>();
    if (!ids.length) return out;
    const rows = await this.q<Record<string, unknown>>(
      `SELECT doc_id, lifecycle, authority_status, (attrs->>'conditional')::boolean AS conditional, freshness, acl_groups, published_content_hash, version, document_type,
              attrs->>'effective_from' AS effective_from, attrs->>'effective_to' AS effective_to
       FROM documents WHERE doc_id = ANY(ARRAY(SELECT jsonb_array_elements_text(:ids::jsonb)))`, { ids });
    for (const r of rows) {
      const st: Record<string, unknown> = { ...r, effective_from: day(r["effective_from"]), effective_to: day(r["effective_to"]) };
      for (const k of Object.keys(st)) if (st[k] === null || st[k] === undefined) delete st[k]; // DynamoDB 때처럼 없는 값은 키 없음
      out.set(String(r["doc_id"]), st as unknown as DocState);
    }
    return out;
  }
  /** 현재 그 분류(하위 포함)에 속한 게시 문서. 병합된 칸은 대상 칸 경로로 본다. LIKE 대신 접두사 비교(이름 속 %·_ 안전) */
  async categoryDocIds(category: string) {
    const rows = await this.q<{ doc_id: string }>(
      `SELECT d.doc_id FROM documents d JOIN categories c ON c.category_id = d.category_id LEFT JOIN categories m ON m.category_id = c.merged_into
       WHERE d.lifecycle = 'PUBLISHED' AND (COALESCE(m.path, c.path) = :cat OR left(COALESCE(m.path, c.path), char_length(:cat) + 1) = :cat || '/')
       LIMIT 1000`, { cat: category });
    return rows.map((r) => r.doc_id);
  }
  /** 현재 분류 경로 (병합된 칸은 대상 칸 경로). 분류 필터를 쓸 때만 호출 */
  async categoryPaths(ids: string[]) {
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const rows = await this.q<{ doc_id: string; path: string }>(
      `SELECT d.doc_id, COALESCE(m.path, c.path) AS path FROM documents d JOIN categories c ON c.category_id = d.category_id
       LEFT JOIN categories m ON m.category_id = c.merged_into WHERE d.doc_id = ANY(ARRAY(SELECT jsonb_array_elements_text(:ids::jsonb)))`, { ids });
    for (const r of rows) out.set(r.doc_id, r.path);
    return out;
  }
}
/** "YYYY-MM-DD" 또는 YYYYMMDD → YYYYMMDD 숫자 */
const day = (v: unknown) => (v === null || v === undefined || v === "" ? undefined : typeof v === "string" ? Number(v.replaceAll("-", "")) : (v as number));

export class DynamoDocStates implements DocStates {
  private readonly db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  private readonly table: string;
  constructor(table: string) { this.table = table; }
  async get(ids: string[]) {
    const out = new Map<string, DocState>();
    for (let i = 0; i < ids.length; i += 100) {
      // Documents 키는 legal-etl KEYS와 같은 규칙 (pk=DOC#{doc_id}, sk=META)
      let keys: Record<string, unknown>[] | undefined = ids.slice(i, i + 100).map((doc_id) => ({ pk: `DOC#${doc_id}`, sk: "META" }));
      for (let attempt = 0; keys?.length; attempt++) {
        if (attempt > 5) throw new Error("BatchGet 미처리 키 재시도 초과");
        const r: import("@aws-sdk/lib-dynamodb").BatchGetCommandOutput = await this.db.send(new BatchGetCommand({ RequestItems: { [this.table]: { Keys: keys, ProjectionExpression: "doc_id, lifecycle, authority_status, conditional, freshness, acl_groups, published_content_hash, effective_from, effective_to, version, document_type" } } }));
        // 승인 API(dhxorb96)는 시행일을 "YYYY-MM-DD"로 저장. 비교는 YYYYMMDD 숫자로
        for (const it of r.Responses?.[this.table] ?? []) out.set(String(it["doc_id"]), { ...it, effective_from: day(it["effective_from"]), effective_to: day(it["effective_to"]) } as DocState);
        keys = r.UnprocessedKeys?.[this.table]?.Keys;
        if (keys?.length) await new Promise((res) => setTimeout(res, 100 * 2 ** attempt));
      }
    }
    return out;
  }
}

const e = process.env;
export const handler = makeHandler(e["KB_ID"] && (e["TABLE_DOCUMENTS"] || e["GOV_STORE"] === "postgres") && e["TABLE_REGULATIONS"]
  ? searchTools({
    retriever: new BedrockRetriever(e["KB_ID"], e["MODEL_RERANK"]),
    states: e["GOV_STORE"] === "postgres" ? new PgDocStates(db().query) : new DynamoDocStates(e["TABLE_DOCUMENTS"]!),
    regulation: regulationTools(new DynamoClauseStore(e["TABLE_REGULATIONS"])),
    ...(e["MODEL_HAIKU"] ? { rewriter: new BedrockRewriter(e["MODEL_HAIKU"]) } : {}), // 없으면 규칙만
    ...(e["BUCKET_PUBLISHED"] ? { published: new S3Published(e["BUCKET_PUBLISHED"]) } : {}), // 없으면 get_wiki_document는 NOT_FOUND
  })
  : {});
export * from "./memory.ts";
