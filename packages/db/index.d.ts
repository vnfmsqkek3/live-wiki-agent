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
