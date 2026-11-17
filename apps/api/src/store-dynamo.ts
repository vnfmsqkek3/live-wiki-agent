// DynamoDB Store. 키 규칙 (테이블 Owner dhxorb96, interfaces.md 4장 pk/sk/gsi1):
//   Documents   pk=DOC#{doc_id}            sk=META
//   Approvals   pk=APR#{approval_id}       sk=META   gsi1pk=APR_STATUS#{status}  gsi1sk={created_at}
//   Feedback    pk=DOC#{doc_id}            sk=USER#{sub}
//   Drafts      pk=DOC#{doc_id}            sk=DRAFT#{draft_id}   (Documents 테이블)
//   AuditEvents pk=AUDIT#{yyyy-mm-dd}      sk={at}#{trace_id}
// 승인 결정·사용은 조건부 쓰기로만 한다 (재사용·자기 승인·검사 후 변경 차단, interfaces.md 7.1).
import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { ApprovalRecord, DocumentRecord, DraftRecord } from './contracts.ts';
import { ApiError } from './errors.ts';
import type { Store } from './store.ts';

export interface Tables { documents: string; approvals: string; feedback: string; audit: string }

export function dynamoStore(t: Tables, client = new DynamoDBClient({})): Store {
  const db = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  const strip = <T>(item: Record<string, unknown> | undefined) => {
    if (!item) return undefined;
    const rest = { ...item };
    for (const k of ['pk', 'sk', 'gsi1pk', 'gsi1sk']) delete rest[k];
    return rest as T;
  };
  const aprKeys = (a: Pick<ApprovalRecord, 'approval_id' | 'status' | 'created_at'>) =>
    ({ pk: `APR#${a.approval_id}`, sk: 'META', gsi1pk: `APR_STATUS#${a.status}`, gsi1sk: a.created_at });

  const getApproval = async (id: string) =>
    strip<ApprovalRecord>((await db.send(new GetCommand({ TableName: t.approvals, Key: { pk: `APR#${id}`, sk: 'META' }, ConsistentRead: true }))).Item);

  return {
    getApproval,
    async getDoc(id) {
      return strip<DocumentRecord>((await db.send(new GetCommand({ TableName: t.documents, Key: { pk: `DOC#${id}`, sk: 'META' }, ConsistentRead: true }))).Item);
    },
    async putDoc(d) {
      await db.send(new PutCommand({ TableName: t.documents, Item: { pk: `DOC#${d.doc_id}`, sk: 'META', ...d } }));
    },
    async listDocs() {
      // ponytail: 전체 Scan. MVP 합성 문서 수십 건 기준, 늘면 gsi1(OWNER#/LIFECYCLE#)로 교체
      const out: DocumentRecord[] = [];
      let ExclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const r = await db.send(new ScanCommand({ TableName: t.documents, ExclusiveStartKey }));
        for (const i of r.Items ?? []) if (i.sk === 'META') out.push(strip<DocumentRecord>(i)!);
        ExclusiveStartKey = r.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return out;
    },
    async createApproval(a) {
      try {
        await db.send(new PutCommand({ TableName: t.approvals, Item: { ...aprKeys(a), ...a }, ConditionExpression: 'attribute_not_exists(pk)' }));
      } catch (e) {
        if (e instanceof ConditionalCheckFailedException) throw new ApiError('CONFLICT', 'approval exists');
        throw e;
      }
    },
    async listApprovals(status) {
      const r = await db.send(new QueryCommand({
        TableName: t.approvals, IndexName: 'gsi1', KeyConditionExpression: 'gsi1pk = :p', ExpressionAttributeValues: { ':p': `APR_STATUS#${status}` },
      }));
      return (r.Items ?? []).map((i) => strip<ApprovalRecord>(i)!);
    },
    async decideApproval(id, n) {
      try {
        const r = await db.send(new UpdateCommand({
          TableName: t.approvals, Key: { pk: `APR#${id}`, sk: 'META' },
          ConditionExpression: 'attribute_exists(pk) AND #s = :pending AND author_sub <> :ap AND s3_version_id = :v AND content_hash = :h',
          UpdateExpression: 'SET #s = :next, gsi1pk = :g, approver_sub = :ap, approver_name = :an, reason = :r, decided_at = :at',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':pending': 'PENDING', ':next': n.status, ':g': `APR_STATUS#${n.status}`, ':ap': n.approver_sub, ':an': n.approver_name ?? '', ':r': n.reason,
            ':at': new Date().toISOString(), ':v': n.s3_version_id, ':h': n.content_hash,
          },
          ReturnValues: 'ALL_NEW',
        }));
        return strip<ApprovalRecord>(r.Attributes)!;
      } catch (e) {
        if (!(e instanceof ConditionalCheckFailedException)) throw e;
        const cur = await getApproval(id); // 실패 사유 분류용 재조회
        if (!cur) throw new ApiError('NOT_FOUND', 'approval not found');
        if (cur.status !== 'PENDING') throw new ApiError('CONFLICT', 'approval is not pending');
        if (cur.author_sub === n.approver_sub) throw new ApiError('FORBIDDEN', 'self approval is not allowed');
        throw new ApiError('CONFLICT', 'document changed after review');
      }
    },
    async consumeApproval(id) {
      try {
        const r = await db.send(new UpdateCommand({
          TableName: t.approvals, Key: { pk: `APR#${id}`, sk: 'META' },
          ConditionExpression: '#s = :ok', UpdateExpression: 'SET #s = :used, gsi1pk = :g',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':ok': 'APPROVED', ':used': 'USED', ':g': 'APR_STATUS#USED' },
          ReturnValues: 'ALL_NEW',
        }));
        return strip<ApprovalRecord>(r.Attributes)!;
      } catch (e) {
        if (e instanceof ConditionalCheckFailedException) throw new ApiError('CONFLICT', 'approval not usable');
        throw e;
      }
    },
    async putFeedback(f) {
      await db.send(new PutCommand({ TableName: t.feedback, Item: { pk: `DOC#${f.doc_id}`, sk: `USER#${f.user_sub}`, ...f } }));
    },
    async putDraft(d) {
      await db.send(new PutCommand({ TableName: t.documents, Item: { pk: `DOC#${d.doc_id}`, sk: `DRAFT#${d.draft_id}`, ...d } }));
    },
    async listDrafts(id) {
      const r = await db.send(new QueryCommand({
        TableName: t.documents, KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)', ExpressionAttributeValues: { ':p': `DOC#${id}`, ':s': 'DRAFT#' },
      }));
      return (r.Items ?? []).map((i) => strip<DraftRecord>(i)!);
    },
    async audit(e) {
      await db.send(new PutCommand({ TableName: t.audit, Item: { pk: `AUDIT#${e.at.slice(0, 10)}`, sk: `${e.at}#${e.trace_id}`, ...e } }));
    },
  };
}
