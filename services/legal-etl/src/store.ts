// 저장소 어댑터. 로직은 인터페이스에만 의존하고, 테스트는 Memory 구현을 쓴다.
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { AuthorityStatus, DocumentType } from "@hanaeum/schemas";

export interface ObjectStore {
  get(bucket: string, key: string): Promise<Buffer>;
  put(bucket: string, key: string, body: Buffer | string, contentType?: string): Promise<void>;
  list(bucket: string, prefix: string): Promise<string[]>;
}

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  async get(bucket: string, key: string) {
    const v = this.objects.get(`${bucket}/${key}`);
    if (!v) throw Object.assign(new Error(`NoSuchKey ${bucket}/${key}`), { name: "NoSuchKey" });
    return v;
  }
  async put(bucket: string, key: string, body: Buffer | string) { this.objects.set(`${bucket}/${key}`, Buffer.from(body)); }
  async list(bucket: string, prefix: string) {
    return [...this.objects.keys()].filter((k) => k.startsWith(`${bucket}/${prefix}`)).map((k) => k.slice(bucket.length + 1)).sort();
  }
}

export class S3ObjectStore implements ObjectStore {
  private readonly s3: S3Client;
  constructor(s3 = new S3Client({})) { this.s3 = s3; }
  async get(bucket: string, key: string) {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async put(bucket: string, key: string, body: Buffer | string, contentType = "application/json") {
    await this.s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
  }
  async list(bucket: string, prefix: string) {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const r = await this.s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) keys.push(o.Key!);
      token = r.NextContinuationToken;
    } while (token);
    return keys.sort();
  }
}

/** Documents 테이블 중 Promote가 읽는 필드 (키·필드명은 yoyo0704·dhxorb96와 합의 대상, 요청기록 참조) */
export interface DocumentRecord {
  doc_id: string;
  version: number;
  title: string;
  document_type: DocumentType;
  authority_status: AuthorityStatus;
  conditional?: boolean;
  dept: string;
  acl_groups: string[];
  law_id?: string;
  law_name?: string;
  revision_id?: string;
  effective_from?: number;
  effective_to?: number;
}

export interface ApprovalRecord {
  approval_id: string; doc_id: string; version: number; content_hash: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "USED"; decided_at?: string; used_by?: string;
}
export interface ConsumeArgs { approval_id: string; doc_id: string; version: number; content_hash: string; workflow_id: string }

export interface Records {
  getDocument(docId: string): Promise<DocumentRecord | undefined>;
  /** interfaces.md 7.1: APPROVED → USED 조건부 전환. 조건 불일치면 예외 (재사용·중복 callback 차단).
   *  같은 워크플로의 재시도(Promote 중간 실패)는 USED + used_by=workflow_id 일 때 허용 (멱등) */
  consumeApproval(a: ConsumeArgs): Promise<ApprovalRecord>;
}

export class MemoryRecords implements Records {
  readonly documents = new Map<string, DocumentRecord>();
  readonly approvals = new Map<string, ApprovalRecord>();
  async getDocument(id: string) { return this.documents.get(id); }
  async consumeApproval(a: ConsumeArgs) {
    const r = this.approvals.get(a.approval_id);
    const usable = r && (r.status === "APPROVED" || (r.status === "USED" && r.used_by === a.workflow_id));
    if (!r || !usable || r.doc_id !== a.doc_id || r.version !== a.version || r.content_hash !== a.content_hash) {
      throw Object.assign(new Error(`승인 바인딩 불일치 또는 재사용: ${a.approval_id}`), { name: "ApprovalBindingError" });
    }
    r.status = "USED";
    r.used_by = a.workflow_id;
    return { ...r };
  }
}

export class DynamoRecords implements Records {
  private readonly db: DynamoDBDocumentClient;
  private readonly tables: { documents: string; approvals: string };
  constructor(tables: { documents: string; approvals: string }, client = new DynamoDBClient({})) {
    this.tables = tables;
    this.db = DynamoDBDocumentClient.from(client);
  }
  async getDocument(doc_id: string) {
    const r = await this.db.send(new GetCommand({ TableName: this.tables.documents, Key: { doc_id } }));
    return r.Item as DocumentRecord | undefined;
  }
  async consumeApproval(a: ConsumeArgs) {
    try {
      const r = await this.db.send(new UpdateCommand({
        TableName: this.tables.approvals,
        Key: { approval_id: a.approval_id },
        UpdateExpression: "SET #s = :used, used_by = :wf, used_at = if_not_exists(used_at, :now)",
        ConditionExpression: "(#s = :approved OR (#s = :used AND used_by = :wf)) AND doc_id = :d AND version = :v AND content_hash = :h",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":used": "USED", ":approved": "APPROVED", ":wf": a.workflow_id, ":d": a.doc_id, ":v": a.version, ":h": a.content_hash, ":now": new Date().toISOString() },
        ReturnValues: "ALL_NEW",
      }));
      return r.Attributes as ApprovalRecord;
    } catch (e) {
      if ((e as Error).name === "ConditionalCheckFailedException") {
        throw Object.assign(new Error(`승인 바인딩 불일치 또는 재사용: ${a.approval_id}`), { name: "ApprovalBindingError" });
      }
      throw e;
    }
  }
}
