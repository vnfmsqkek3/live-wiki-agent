// 조문 구조화 저장소 (Structured Store, docs/01 7.1·8.4: 원본 구조·버전의 기준. KB는 파생 인덱스)
// DynamoDB 키 제안 (yoyo0704 합의 대상, 요청기록 참조): Regulations 테이블
//   pk = LAW#{law_id}  sk = REV#{revision_id}                → RevisionRecord
//   pk = LAW#{law_id}  sk = REV#{revision_id}#P#{rel_path}   → Provision
//   pk = LAWNAMES      sk = LAW#{law_id}                     → 법령명 목록
//   pk = REGHASH#{sha256:hex}  sk = REV                      → {law_id, revision_id} (Registry 해시 → 개정본)
// 테이블 키 스키마 pk/sk(S)는 yoyo0704 배포본 (interfaces.md 4장). 키 값은 Owner인 let522mj가 정함
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand, UpdateCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { AuthorityStatus, ParsedLaw, Provision } from "@hanaeum/schemas";

export interface RevisionRecord {
  law_id: string; law_name: string; revision_id: string; registry_doc_no?: string;
  effective_from: number; effective_to: number; authority_status: AuthorityStatus;
  doc_id: string; content_hash: string; acl_groups: string[];
  pdf_content_hash?: string; // 데모 업로드(PDF) 원본 해시. Trust Gate는 업로드 바이트 해시를 content_hash 또는 이것과 대조
  parse_ok: boolean; // 구조 파싱 이슈 0건일 때만 true. false면 부재 판정 금지(UNVERIFIED)
}

export interface ClauseStore {
  lawIdByName(nameOrId: string): Promise<string | undefined>;
  revisions(lawId: string): Promise<RevisionRecord[]>;
  provisions(lawId: string, revisionId: string): Promise<Provision[] | undefined>;
  /** Registry 원본 해시(content_hash·pdf_content_hash)로 개정본 찾기 */
  revisionByHash(hash: string): Promise<RevisionRecord | undefined>;
}

import { relPath } from "@hanaeum/legal-parser";
export { relPath };
const squash = (s: string) => s.replace(/\s+/gu, "");
/** 질의 문장 속 법령명 매칭: 완전 일치 우선, 없으면 문장에 포함된 가장 긴 법령명 */
export function matchLawName(text: string, laws: { law_id: string; law_name: string }[]): string | undefined {
  const t = squash(text);
  return laws.find((l) => squash(l.law_name) === t)?.law_id
    ?? laws.filter((l) => t.includes(squash(l.law_name))).sort((a, b) => b.law_name.length - a.law_name.length)[0]?.law_id
    // 약칭: "기업여신 심사규정" → "하나은행 기업여신 심사규정" (기관명 생략). 후보가 하나일 때만
    ?? (() => { const c = [...new Set(laws.filter((l) => t.length >= 4 && squash(l.law_name).endsWith(t)).map((l) => l.law_id))]; return c.length === 1 ? c[0] : undefined; })();
}

export class MemoryClauseStore implements ClauseStore {
  readonly revs: RevisionRecord[] = [];
  readonly provs = new Map<string, Provision[]>();
  put(rec: RevisionRecord, law?: ParsedLaw) {
    // DynamoDB putLaw와 같게: 같은 법령·개정본은 덮어쓴다
    const i = this.revs.findIndex((r) => r.law_id === rec.law_id && r.revision_id === rec.revision_id);
    if (i >= 0) this.revs[i] = rec; else this.revs.push(rec);
    if (law) this.provs.set(`${rec.law_id}@${rec.revision_id}`, law.provisions);
  }
  async lawIdByName(n: string) {
    return this.revs.find((r) => r.law_id === n || r.registry_doc_no === n)?.law_id
      ?? matchLawName(n, this.revs.map((r) => ({ law_id: r.law_id, law_name: r.law_name })));
  }
  async revisions(lawId: string) { return this.revs.filter((r) => r.law_id === lawId).sort((a, b) => a.effective_from - b.effective_from); }
  async closeRevision(lawId: string, rev: string, effectiveTo: number) {
    const r = this.revs.find((x) => x.law_id === lawId && x.revision_id === rev);
    if (r && r.effective_to > effectiveTo) r.effective_to = effectiveTo;
  }
  async provisions(lawId: string, rev: string) { return this.provs.get(`${lawId}@${rev}`); }
  async revisionByHash(h: string) { return h ? this.revs.find((r) => r.content_hash === h || r.pdf_content_hash === h) : undefined; }
}

/** Browser 조회 결과 캐시: Regulations 테이블 pk=WEBLAW#{법령명} sk=LATEST (본문 수십 KB, 항목 한도 400KB 안) */
export class DynamoLawPageCache {
  private readonly db: DynamoDBDocumentClient;
  private readonly table: string;
  constructor(table: string, client = new DynamoDBClient({})) { this.table = table; this.db = DynamoDBDocumentClient.from(client); }
  async get(lawName: string) {
    const r = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: `WEBLAW#${lawName}`, sk: "LATEST" } }));
    return r.Item as { url: string; header: string; body: string; fetched_at: string } | undefined;
  }
  async put(lawName: string, page: { url: string; header: string; body: string }, fetched_at: string) {
    await this.db.send(new PutCommand({ TableName: this.table, Item: { pk: `WEBLAW#${lawName}`, sk: "LATEST", ...page, fetched_at } }));
  }
}

export class DynamoClauseStore implements ClauseStore {
  private readonly db: DynamoDBDocumentClient;
  private readonly table: string;
  constructor(table: string, client = new DynamoDBClient({})) { this.table = table; this.db = DynamoDBDocumentClient.from(client); }

  private async query(pk: string, prefix: string) {
    const items: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = await this.db.send(new QueryCommand({
        TableName: this.table, KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)",
        ExpressionAttributeValues: { ":pk": pk, ":p": prefix }, ExclusiveStartKey: start,
      }));
      items.push(...(r.Items ?? []));
      start = r.LastEvaluatedKey;
    } while (start);
    return items;
  }
  async lawIdByName(n: string) {
    if (/^[A-Z][A-Z0-9-]+$/u.test(n)) return n;
    // ponytail: 법령명 목록을 PK=LAWNAMES 한 파티션에 둠 (법령 수백 건까지 충분). 많아지면 GSI
    const laws = (await this.query("LAWNAMES", "LAW#")) as unknown as { law_id: string; law_name: string }[];
    return matchLawName(n, laws);
  }
  async revisions(lawId: string) {
    return (await this.query(`LAW#${lawId}`, "REV#")).filter((i) => !String(i["sk"]).includes("#P#")) as unknown as RevisionRecord[];
  }
  async provisions(lawId: string, rev: string) {
    const items = await this.query(`LAW#${lawId}`, `REV#${rev}#P#`);
    return items.length ? (items as unknown as Provision[]).sort((a, b) => a.source_line - b.source_line) : undefined;
  }
  async revisionByHash(h: string) {
    const [hit] = h ? await this.query(`REGHASH#${h}`, "REV") : [];
    if (!hit) return undefined;
    return (await this.query(`LAW#${String(hit["law_id"])}`, `REV#${String(hit["revision_id"])}`)).find((i) => i["sk"] === `REV#${String(hit["revision_id"])}`) as unknown as RevisionRecord | undefined;
  }
  /** 이전 버전 종료일 갱신 (더 늦은 값일 때만 앞당김) */
  async closeRevision(lawId: string, rev: string, effectiveTo: number) {
    try {
      await this.db.send(new UpdateCommand({
        TableName: this.table, Key: { pk: `LAW#${lawId}`, sk: `REV#${rev}` },
        UpdateExpression: "SET effective_to = :t", ConditionExpression: "attribute_exists(pk) AND effective_to > :t",
        ExpressionAttributeValues: { ":t": effectiveTo },
      }));
    } catch (e) { if ((e as Error).name !== "ConditionalCheckFailedException") throw e; }
  }
  /** 승인된 법령 버전 적재 (Promote 이후 호출). 25건 배치. 같은 버전을 다시 올리면 새 결과에 없는 조문은 지운다
   *  (파싱 이슈 본도 적재하므로, 잘못 읽힌 "제31조"가 고친 재업로드 뒤에도 FOUND로 남지 않게. PR #64 리뷰) */
  async putLaw(rec: RevisionRecord, law: ParsedLaw) {
    const keep = new Set(law.provisions.map((p) => `REV#${rec.revision_id}#P#${relPath(p.provision_id)}`));
    const stale = (await this.query(`LAW#${rec.law_id}`, `REV#${rec.revision_id}#P#`)).map((i) => String(i["sk"])).filter((sk) => !keep.has(sk));
    const items = [
      { pk: "LAWNAMES", sk: `LAW#${rec.law_id}`, law_id: rec.law_id, law_name: rec.law_name },
      { pk: `LAW#${rec.law_id}`, sk: `REV#${rec.revision_id}`, ...rec },
      ...[rec.content_hash, rec.pdf_content_hash].filter(Boolean).map((h) => ({ pk: `REGHASH#${h}`, sk: "REV", law_id: rec.law_id, revision_id: rec.revision_id })),
      ...law.provisions.map((p) => ({ pk: `LAW#${rec.law_id}`, sk: `REV#${rec.revision_id}#P#${relPath(p.provision_id)}`, ...p })),
    ];
    for (let i = 0; i < items.length; i += 25) await this.batch(items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })));
    for (let i = 0; i < stale.length; i += 25) await this.batch(stale.slice(i, i + 25).map((sk) => ({ DeleteRequest: { Key: { pk: `LAW#${rec.law_id}`, sk } } })));
  }
  /** BatchWrite 25건 + 미처리 항목 재시도 */
  private async batch(reqs: Record<string, unknown>[]) {
    let req: Record<string, Record<string, unknown>[]> | undefined = { [this.table]: reqs };
    for (let attempt = 0; req && Object.keys(req).length; attempt++) {
      if (attempt > 5) throw new Error("BatchWrite 미처리 항목 재시도 초과");
      const r = await this.db.send(new BatchWriteCommand({ RequestItems: req as never }));
      req = r.UnprocessedItems as typeof req;
      if (req && Object.keys(req).length) await new Promise((res) => setTimeout(res, 100 * 2 ** attempt));
    }
  }
}
