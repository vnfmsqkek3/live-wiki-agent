// 조문 구조화 저장소 (Structured Store, docs/01 7.1·8.4: 원본 구조·버전의 기준. KB는 파생 인덱스)
// DynamoDB 키 제안 (yoyo0704 합의 대상, 요청기록 참조): Regulations 테이블
//   PK = LAW#{law_id}  SK = REV#{revision_id}                → RevisionRecord
//   PK = LAW#{law_id}  SK = REV#{revision_id}#P#{rel_path}   → Provision
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { AuthorityStatus, ParsedLaw, Provision } from "@hanaeum/schemas";

export interface RevisionRecord {
  law_id: string; law_name: string; revision_id: string; registry_doc_no?: string;
  effective_from: number; effective_to: number; authority_status: AuthorityStatus;
  doc_id: string; content_hash: string; acl_groups: string[];
  parse_ok: boolean; // 구조 파싱 이슈 0건일 때만 true. false면 부재 판정 금지(UNVERIFIED)
}

export interface ClauseStore {
  lawIdByName(nameOrId: string): Promise<string | undefined>;
  revisions(lawId: string): Promise<RevisionRecord[]>;
  provisions(lawId: string, revisionId: string): Promise<Provision[] | undefined>;
}

export const relPath = (provisionId: string) => provisionId.slice(provisionId.indexOf("/") + 1);
const squash = (s: string) => s.replace(/\s+/gu, "");
/** 질의 문장 속 법령명 매칭: 완전 일치 우선, 없으면 문장에 포함된 가장 긴 법령명 */
export function matchLawName(text: string, laws: { law_id: string; law_name: string }[]): string | undefined {
  const t = squash(text);
  return laws.find((l) => squash(l.law_name) === t)?.law_id
    ?? laws.filter((l) => t.includes(squash(l.law_name))).sort((a, b) => b.law_name.length - a.law_name.length)[0]?.law_id;
}

export class MemoryClauseStore implements ClauseStore {
  readonly revs: RevisionRecord[] = [];
  readonly provs = new Map<string, Provision[]>();
  put(rec: RevisionRecord, law?: ParsedLaw) {
    this.revs.push(rec);
    if (law) this.provs.set(`${rec.law_id}@${rec.revision_id}`, law.provisions);
  }
  async lawIdByName(n: string) {
    return this.revs.find((r) => r.law_id === n || r.registry_doc_no === n)?.law_id
      ?? matchLawName(n, this.revs.map((r) => ({ law_id: r.law_id, law_name: r.law_name })));
  }
  async revisions(lawId: string) { return this.revs.filter((r) => r.law_id === lawId).sort((a, b) => a.effective_from - b.effective_from); }
  async provisions(lawId: string, rev: string) { return this.provs.get(`${lawId}@${rev}`); }
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
        TableName: this.table, KeyConditionExpression: "PK = :pk AND begins_with(SK, :p)",
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
    return (await this.query(`LAW#${lawId}`, "REV#")).filter((i) => !String(i["SK"]).includes("#P#")) as unknown as RevisionRecord[];
  }
  async provisions(lawId: string, rev: string) {
    const items = await this.query(`LAW#${lawId}`, `REV#${rev}#P#`);
    return items.length ? (items as unknown as Provision[]).sort((a, b) => a.source_line - b.source_line) : undefined;
  }
  /** 승인된 법령 버전 적재 (Promote 이후 호출). 25건 배치 */
  async putLaw(rec: RevisionRecord, law: ParsedLaw) {
    const items = [
      { PK: "LAWNAMES", SK: `LAW#${rec.law_id}`, law_id: rec.law_id, law_name: rec.law_name },
      { PK: `LAW#${rec.law_id}`, SK: `REV#${rec.revision_id}`, ...rec },
      ...law.provisions.map((p) => ({ PK: `LAW#${rec.law_id}`, SK: `REV#${rec.revision_id}#P#${relPath(p.provision_id)}`, ...p })),
    ];
    for (let i = 0; i < items.length; i += 25) {
      let req: Record<string, { PutRequest: { Item: Record<string, unknown> } }[]> | undefined = {
        [this.table]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })),
      };
      for (let attempt = 0; req && Object.keys(req).length; attempt++) {
        if (attempt > 5) throw new Error("BatchWrite 미처리 항목 재시도 초과");
        const r = await this.db.send(new BatchWriteCommand({ RequestItems: req }));
        req = r.UnprocessedItems as typeof req;
        if (req && Object.keys(req).length) await new Promise((res) => setTimeout(res, 100 * 2 ** attempt));
      }
    }
  }
}
