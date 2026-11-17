import type { RDSDataClient, SqlParameter } from "@aws-sdk/client-rds-data";

export type Params = Record<string, string | number | boolean | null | undefined | object>;
export type Query = <T = Record<string, unknown>>(sql: string, params?: Params) => Promise<T[]>;
export interface Db {
  query: Query;
  tx<T>(fn: (q: Query) => Promise<T>): Promise<T>;
}
export function db(cfg?: { resourceArn?: string; secretArn?: string; database?: string; client?: Pick<RDSDataClient, "send">; sleep?: (ms: number) => Promise<void> }): Db;
export function toParam(name: string, v: unknown): SqlParameter;
export function fromColumn(typeName: string | undefined, v: unknown): unknown;
export function pgCode(e: unknown): string | undefined;

export const DOC_COLUMNS: readonly string[];
export function toDocumentRow(doc: Record<string, unknown>): Record<string, unknown> & { attrs: Record<string, unknown> };
export function fromDocumentRow<T = Record<string, unknown>>(row: Record<string, unknown>, findingRows?: Record<string, unknown>[]): T;
export function toFindingRow(doc_id: string, f: { finding_id: string; step: string; severity: string; code: string } & Record<string, unknown>): Record<string, unknown>;
export const UPSERT_DOCUMENT_SQL: string;
export function replaceStepFindings(q: Query, doc_id: string, step: string, findings: ({ finding_id: string; step: string; severity: string; code: string } & Record<string, unknown>)[]): Promise<void>;
