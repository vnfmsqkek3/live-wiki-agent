// 실환경(KB·DynamoDB) 정량 측정 — docs/02 4장 중 let522mj 담당분. 오프라인 measure.ts와 같은 케이스를 실 KB로 다시 잰다.
// 실행 (E2E 색인 후): HANAEUM_ENV=prod node tests/evaluations/cases/src/measure-kb.ts
//   환경: AWS_PROFILE·AWS_REGION (.env.local). KB_ID 등은 SSM /hanaeum-mvp/{HANAEUM_ENV}/* 에서 읽는다 (publish-regs-dev.sh와 같은 규칙: prod 외에는 dev)
// 측정 함수는 의존성을 주입받으므로 오프라인 테스트(메모리 KB)로 검출 로직을 먼저 검증한다.
import { readFileSync } from "node:fs";
import type { Retriever } from "@hanaeum/search-server";
import type { searchTools } from "@hanaeum/search-server";
import { EVAL_TODAY } from "./measure.ts";

const FIX = new URL("../../../fixtures/", import.meta.url);
const CASES = new URL("../", import.meta.url);
const read = (u: URL) => readFileSync(u, "utf8");
const jsonl = <T>(f: string) => read(new URL(f, CASES)).split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
const USER = { sub: "eval-user", groups: ["USER"], dept: "여신" };
const squash = (s: string) => s.replace(/[\sㆍ·]/gu, "");

interface Doc { document_id: string; file: string; expected_kb_visibility: boolean | string }
const docs = (JSON.parse(read(new URL("golden/manifest.json", FIX))) as { documents: Doc[] }).documents;

/** 게시되면 안 되는 문서의 고유 문장: 게시 대상 문서 어디에도 없는 가장 긴 줄 3개 */
export function fingerprints(): { id: string; lines: string[] }[] {
  const text = (d: Doc) => (d.file.endsWith(".png") ? "" : read(new URL(d.file, FIX)).replace(/^---\n[\s\S]*?\n---\n/u, ""));
  const visible = squash(docs.filter((d) => d.expected_kb_visibility === true).map(text).join("\n"));
  return docs.filter((d) => d.expected_kb_visibility === false && !d.file.endsWith(".png")).map((d) => ({
    id: d.document_id,
    lines: text(d).split("\n").map((l) => l.replace(/^[-#\d.\s]+/u, "").trim())
      .filter((l) => squash(l).length >= 15 && !/^SYNTHETIC/u.test(l) && !visible.includes(squash(l)))
      .sort((a, b) => b.length - a.length).slice(0, 3),
  })).filter((f) => f.lines.length);
}

export interface LiveDeps { raw: Retriever; search: ReturnType<typeof searchTools> }

/** 승인 전·차단 문서 KB 노출: 필터 없이 조회해 고유 문장 30자가 들어간 청크가 하나라도 있으면 노출 */
export async function measureVisibility(raw: Retriever) {
  const visible: string[] = [];
  const fps = fingerprints();
  for (const f of fps) {
    for (const line of f.lines) {
      const hits = await raw.retrieve(line);
      const probe = squash(line).slice(0, 30);
      if (hits.some((h) => squash(h.text).includes(probe) || squash(String(h.metadata["original_text"] ?? "")).includes(probe))) { visible.push(f.id); break; }
    }
  }
  return { checked: fps.length, visible };
}

interface ClauseCase { id: string; query: string; as_of: string; expected_status: string; expected_provision_id?: string; expected_text?: string }
interface CiteCase { id: string; question: string; as_of: string; expected_provision_ids: string[]; forbidden_provision_ids?: string[] }

export async function measureLive(d: LiveDeps) {
  const clause = { total: 0, correct: 0, fails: [] as string[] };
  for (const c of jsonl<ClauseCase>("clause_lookup.jsonl")) {
    const r = await d.search.search_legal_clause({ query: c.query, as_of: c.as_of }, USER) as { search_status: string; provision_id?: string; original_text?: string };
    const ok = r.search_status === c.expected_status && (!c.expected_provision_id || r.provision_id === c.expected_provision_id) && (!c.expected_text || !!r.original_text?.includes(c.expected_text));
    clause.total++; if (ok) clause.correct++; else clause.fails.push(`${c.id}: ${r.search_status} ${r.provision_id ?? ""}`);
  }
  // 근거 검색 Recall@5 + 금지 근거(삭제·과거·위조) 반환 여부
  const cite = { total: 0, hit: 0, forbidden: [] as string[] };
  for (const c of jsonl<CiteCase>("citation.jsonl")) {
    const r = await d.search.search_wiki({ query: c.question, as_of: c.as_of, top_k: 5 }, USER);
    const ids = r.items.map((x) => x.provision_id);
    cite.total++;
    if (c.expected_provision_ids.some((p) => ids.includes(p))) cite.hit++;
    if ((c.forbidden_provision_ids ?? []).some((p) => ids.includes(p))) cite.forbidden.push(c.id);
  }
  // 삭제 조항 오인용: 사용자 검색 결과에 DELETED 조문이 현행으로 나오면 오인용
  let deletionMis = 0;
  for (const c of jsonl<ClauseCase>("clause_lookup.jsonl").filter((x) => x.expected_status === "DELETED")) {
    const r = await d.search.search_wiki({ query: c.query, as_of: c.as_of }, USER);
    if (r.items.some((x) => x.provision_status === "DELETED" || x.provision_id === c.expected_provision_id)) deletionMis++;
  }
  return { clause, cite, deletionMis, unverified: await measureUnverified(d.search, true), visibility: await measureVisibility(d.raw) };
}

interface UvCase { id: string; tool: "search_legal_clause" | "search_wiki"; query: string; as_of: string; live_only?: boolean }
/** docs/02 4장 "검색 실패 판정: UNVERIFIED를 부재 확정으로 단정 0건" — 근거가 없거나 불확실한 질의에서
 *  NOT_FOUND_VERIFIED(단정)·FOUND(무관한 근거 제시)가 나오면 실패. live=false면 실제 Rerank가 필요한 케이스 제외 */
export async function measureUnverified(search: LiveDeps["search"], live: boolean) {
  const out = { total: 0, ok: 0, asserted: [] as string[], spurious: [] as string[] };
  for (const c of jsonl<UvCase>("unverified.jsonl").filter((x) => live || !x.live_only)) {
    const r = await (search[c.tool] as (a: Record<string, unknown>, u: typeof USER) => Promise<{ search_status: string }>)({ query: c.query, as_of: c.as_of }, USER);
    out.total++;
    if (r.search_status === "UNVERIFIED") out.ok++;
    else if (r.search_status === "NOT_FOUND_VERIFIED") out.asserted.push(c.id);
    else out.spurious.push(`${c.id}:${r.search_status}`);
  }
  return out;
}

if (import.meta.main) {
  const { execFileSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const env = process.env["HANAEUM_ENV"] === "prod" ? "prod" : "dev";
  const ssm = (n: string) => execFileSync("aws", ["ssm", "get-parameter", "--name", `/hanaeum-mvp/${env}/${n}`, "--query", "Parameter.Value", "--output", "text"]).toString().trim();
  const { BedrockRetriever, DynamoDocStates, searchTools: tools } = await import("@hanaeum/search-server");
  const { DynamoClauseStore, regulationTools } = await import("@hanaeum/regulation-server");
  const kb = ssm("KB_ID");
  const retriever = new BedrockRetriever(kb, ssm("MODEL_RERANK"));
  const local = tools({ retriever, states: new DynamoDocStates(ssm("TABLE_DOCUMENTS")), regulation: regulationTools(new DynamoClauseStore(ssm("TABLE_REGULATIONS")), { today: () => EVAL_TODAY }) });
  // prod는 문서 상태가 Postgres(VPC 안)라 로컬에서 못 읽음 → search_wiki는 배포된 검색 Lambda를 그대로 호출 (prod 1회차 11/18: Dynamo로 읽어 전부 재검증 탈락)
  // ponytail: aws CLI 호출(건당 ~1초). 케이스가 수백 건이 되면 @aws-sdk/client-lambda로
  const viaLambda = async (args: Record<string, unknown>, actor: unknown) => {
    const ctx = Buffer.from(JSON.stringify({ custom: { bedrockAgentCoreToolName: "search___search_wiki" } })).toString("base64");
    const f = join(tmpdir(), `measure-${process.pid}.json`);
    execFileSync("aws", ["lambda", "invoke", "--function-name", "hanaeum-mvp-lambda-mcp-search", "--cli-binary-format", "raw-in-base64-out",
      "--client-context", ctx, "--payload", JSON.stringify({ ...args, __actor: actor }), f], { stdio: ["ignore", "ignore", "inherit"] });
    const r = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
    return (typeof r["body"] === "string" ? JSON.parse(r["body"]) : r) as Awaited<ReturnType<typeof local.search_wiki>>;
  };
  const search = env === "prod" ? { ...local, search_wiki: viaLambda } : local;
  const r = await measureLive({ raw: new BedrockRetriever(kb), search });
  console.log(`| 항목 | 목표 | 실환경 (KB ${kb}, 기준일 ${EVAL_TODAY}) | 판정 |`);
  console.log("|---|---|---|---|");
  console.log(`| 정확 조문 검색 | 19/20 | ${r.clause.correct}/${r.clause.total} | ${r.clause.correct >= 19 ? "통과" : "미달"} |`);
  console.log(`| 삭제 조항 오인용 | 0 | ${r.deletionMis} | ${r.deletionMis === 0 ? "통과" : "미달"} |`);
  console.log(`| 승인 전·차단 문서 KB 노출 | 0 | ${r.visibility.visible.length}/${r.visibility.checked} ${r.visibility.visible.join(",")} | ${r.visibility.visible.length === 0 ? "통과" : "미달"} |`);
  console.log(`| 근거 인용 (근거 검색 Recall@5) | 19/20 | ${r.cite.hit}/${r.cite.total}, 금지 근거 반환 ${r.cite.forbidden.length} | ${r.cite.hit >= 19 && !r.cite.forbidden.length ? "통과" : "미달"} |`);
  console.log(`| 검색 실패 판정 (UNVERIFIED를 부재로 단정) | 0 | 단정 ${r.unverified.asserted.length}, 무관 근거 ${r.unverified.spurious.length} (UNVERIFIED ${r.unverified.ok}/${r.unverified.total}) ${[...r.unverified.asserted, ...r.unverified.spurious].join(",")} | ${r.unverified.asserted.length === 0 && r.unverified.spurious.length === 0 ? "통과" : "미달"} |`);
  for (const f of r.clause.fails) console.log("  조문 실패", f);
}
