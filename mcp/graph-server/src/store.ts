// 그래프 저장소: Neptune openCypher(SigV4) / 메모리. 쓰기는 UNWIND MERGE 배치 50 (docs/04 5장)
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import type { GEdge, GNode, Graph } from "./model.ts";

export const BATCH = 50;

export interface CiteRow { wiki_id: string; wiki_doc_id: string; title: string; acl: string; provision_id: string; law_id: string; path: string; evidence_span: string }
export interface OutEdge { type: string; to: string; to_label: string; to_acl: string | null; from_acl: string | null; props: Record<string, unknown> }
export interface RefRow { from_id: string; from_path: string; to_path: string; law_id: string; revision_id: string }

export interface GraphStore {
  upsert(g: Graph): Promise<void>;
  deleteDoc(docId: string): Promise<void>;
  /** law_id의 모든 버전에서 경로가 겹치는(조상·자손 포함) 조문을 인용하는 노하우 */
  citers(lawId: string, paths: string[]): Promise<CiteRow[]>;
  /** law_id 안에서 paths를 REFERENCES로 가리키는 조문 (간접 영향 1홉) */
  referrers(lawId: string, paths: string[]): Promise<RefRow[]>;
  outgoing(id: string): Promise<OutEdge[]>;
}

/** 경로 겹침: 같거나, 한쪽이 다른 쪽의 상위 */
export const overlaps = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");

/** 노드·엣지 → openCypher 배치 문장 (레이블·관계 타입별로 묶음). 재실행해도 결과 동일 */
export function upsertStatements(g: Graph): { query: string; parameters: { items: unknown[] } }[] {
  const out: { query: string; parameters: { items: unknown[] } }[] = [];
  const group = <T>(xs: T[], key: (x: T) => string) => xs.reduce((m, x) => m.set(key(x), [...(m.get(key(x)) ?? []), x]), new Map<string, T[]>());
  for (const [label, ns] of group(g.nodes, (n) => n.label)) {
    for (let i = 0; i < ns.length; i += BATCH) {
      out.push({ query: `UNWIND $items AS i MERGE (n:${label} {id: i.id}) SET n += i.props`, parameters: { items: ns.slice(i, i + BATCH).map((n) => ({ id: n.id, props: n.props })) } });
    }
  }
  for (const [k, es] of group(g.edges, (e) => `${e.type}|${e.fromLabel}|${e.toLabel}`)) {
    const [type, fl, tl] = k.split("|");
    for (let i = 0; i < es.length; i += BATCH) {
      out.push({
        query: `UNWIND $items AS i MATCH (a:${fl} {id: i.from}) MATCH (b:${tl} {id: i.to}) MERGE (a)-[r:${type}]->(b) SET r += i.props`,
        parameters: { items: es.slice(i, i + BATCH).map((e) => ({ from: e.from, to: e.to, props: e.props })) },
      });
    }
  }
  return out;
}

export class MemoryGraphStore implements GraphStore {
  readonly nodes = new Map<string, GNode>();
  readonly edges = new Map<string, GEdge>();
  async upsert(g: Graph) {
    for (const n of g.nodes) this.nodes.set(n.id, { ...n, props: { ...this.nodes.get(n.id)?.props, ...n.props } });
    for (const e of g.edges) if (this.nodes.has(e.from) && this.nodes.has(e.to)) this.edges.set(`${e.from}|${e.type}|${e.to}`, e); // MATCH 실패 = 미적재 (Neptune과 동일)
  }
  async deleteDoc(docId: string) {
    for (const [k, n] of this.nodes) if (n.props["doc_id"] === docId) this.nodes.delete(k);
    for (const [k, e] of this.edges) if (!this.nodes.has(e.from) || !this.nodes.has(e.to) || e.props.doc_id === docId) this.edges.delete(k);
  }
  async citers(lawId: string, paths: string[]) {
    const rows: CiteRow[] = [];
    for (const e of this.edges.values()) {
      if (e.type !== "CITES") continue;
      const p = this.nodes.get(e.to)!; const w = this.nodes.get(e.from)!;
      if (p.props["law_id"] !== lawId || !paths.some((x) => overlaps(String(p.props["path"]), x))) continue;
      rows.push({ wiki_id: w.id, wiki_doc_id: String(w.props["doc_id"]), title: String(w.props["title"]), acl: String(w.props["acl"] ?? ""), provision_id: p.id, law_id: lawId, path: String(p.props["path"]), evidence_span: e.props.evidence_span });
    }
    return rows;
  }
  async referrers(lawId: string, paths: string[]) {
    const rows: RefRow[] = [];
    for (const e of this.edges.values()) {
      if (e.type !== "REFERENCES") continue;
      const a = this.nodes.get(e.from)!; const b = this.nodes.get(e.to)!;
      if (b.props["law_id"] !== lawId || !paths.some((x) => overlaps(String(b.props["path"]), x))) continue;
      rows.push({ from_id: a.id, from_path: String(a.props["path"]), to_path: String(b.props["path"]), law_id: lawId, revision_id: String(a.props["revision_id"]) });
    }
    return rows;
  }
  async outgoing(id: string) {
    const acl = (n?: GNode) => (n?.props["acl"] === undefined ? null : String(n.props["acl"]));
    return [...this.edges.values()].filter((e) => e.from === id)
      .map((e) => ({ type: e.type, to: e.to, to_label: e.toLabel, to_acl: acl(this.nodes.get(e.to)), from_acl: acl(this.nodes.get(e.from)), props: e.props }));
  }
}

// ── Neptune ────────────────────────────────────────────
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export class NeptuneGraphStore implements GraphStore {
  private readonly endpoint: string;
  private readonly signer: SignatureV4;
  constructor(endpoint: string, region = process.env["AWS_REGION"] ?? "us-east-1") {
    this.endpoint = endpoint.replace(/^https?:\/\//u, "").replace(/\/$/u, "");
    this.signer = new SignatureV4({ service: "neptune-db", region, credentials: defaultProvider(), sha256: Sha256 });
  }
  async run<T = Record<string, unknown>>(query: string, parameters: Record<string, unknown> = {}): Promise<T[]> {
    const [host, port = "8182"] = this.endpoint.split(":");
    const body = new URLSearchParams({ query, parameters: JSON.stringify(parameters) }).toString();
    for (let attempt = 0; ; attempt++) {
      const req = await this.signer.sign(new HttpRequest({
        method: "POST", protocol: "https:", hostname: host!, port: Number(port), path: "/openCypher",
        headers: { host: `${host}:${port}`, "content-type": "application/x-www-form-urlencoded" }, body,
      }));
      let res: Response | undefined;
      try { res = await fetch(`https://${host}:${port}/openCypher`, { method: "POST", headers: req.headers, body }); } catch { /* 연결 오류 → 재시도 */ }
      if (res?.ok) {
        const text = await res.text();
        if (text) return (JSON.parse(text) as { results: T[] }).results;
      } else if (res && !RETRY_STATUS.has(res.status)) {
        throw new Error(`Neptune ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      if (attempt >= 4) throw new Error(`Neptune 재시도 초과 (${res?.status ?? "연결 오류/빈 응답"})`);
      await new Promise((r) => setTimeout(r, 200 * 2 ** attempt + Math.random() * 100));
    }
  }
  // 쓰기 직렬화는 인프라에서 보장 (GraphUpsert Lambda reserved concurrency 1 또는 SFN Map 동시 1)
  async upsert(g: Graph) { for (const s of upsertStatements(g)) await this.run(s.query, s.parameters); }
  async deleteDoc(docId: string) {
    // 관계부터 배치 삭제 후 노드 삭제 (대량 삭제 시 타임아웃 방지)
    for (;;) {
      const r = await this.run<{ n: number }>("MATCH ()-[r]->() WHERE r.doc_id = $d WITH r LIMIT 500 DELETE r RETURN count(*) AS n", { d: docId });
      if (!r[0]?.n) break;
    }
    await this.run("MATCH (n {doc_id: $d}) DETACH DELETE n", { d: docId });
  }
  async citers(lawId: string, paths: string[]) {
    const rows = await this.run<CiteRow>(
      "MATCH (w:WIKI_VERSION)-[c:CITES]->(p) WHERE p.law_id = $law RETURN w.id AS wiki_id, w.doc_id AS wiki_doc_id, w.title AS title, w.acl AS acl, p.id AS provision_id, p.law_id AS law_id, p.path AS path, c.evidence_span AS evidence_span",
      { law: lawId });
    return rows.filter((r) => paths.some((x) => overlaps(r.path, x)));
  }
  async referrers(lawId: string, paths: string[]) {
    const rows = await this.run<RefRow>(
      "MATCH (a)-[:REFERENCES]->(b) WHERE b.law_id = $law RETURN a.id AS from_id, a.path AS from_path, b.path AS to_path, b.law_id AS law_id, a.revision_id AS revision_id",
      { law: lawId });
    return rows.filter((r) => paths.some((x) => overlaps(r.to_path, x)));
  }
  async outgoing(id: string) {
    return this.run<OutEdge>(
      "MATCH (a {id: $id})-[r]->(b) RETURN type(r) AS type, b.id AS to, labels(b)[0] AS to_label, b.acl AS to_acl, a.acl AS from_acl, properties(r) AS props", { id });
  }
}
