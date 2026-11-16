import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chunkDocument } from "@hanaeum/kb-chunker";
import { regulationTools } from "@hanaeum/regulation-server";
import { fixtureClauseStore } from "../../regulation-server/src/fixtures.ts";
import type { DocumentMetadata } from "@hanaeum/schemas";
import { buildFilter, searchTools, MemoryRetriever, MemoryDocStates } from "./index.ts";

const FIX = new URL("../../../tests/fixtures/", import.meta.url);
const H = (c: string) => "sha256:" + c.repeat(64);
const base = { index_group: "legal-clauses" as const, authority_status: "VERIFIED" as const, freshness: "CURRENT" as const, lifecycle: "PUBLISHED" as const, acl_groups: ["ALL"], dept: "여신", approval_id: "apr_1" };
const docs: [string, DocumentMetadata][] = [
  ["documents/F-001.txt", { ...base, doc_id: "F-001", title: "한빛은행 기업여신 심사규정", law_name: "한빛은행 기업여신 심사규정", document_type: "REGULATION", law_id: "SYN-LOAN-001", revision_id: "2026-11-01", effective_from: 20261101, effective_to: 20261130, content_hash: H("1") }],
  ["documents/F-002.txt", { ...base, doc_id: "F-002", title: "한빛은행 기업여신 심사규정", law_name: "한빛은행 기업여신 심사규정", document_type: "REGULATION", law_id: "SYN-LOAN-001", revision_id: "2026-12-01", effective_from: 20261201, effective_to: 99991231, content_hash: H("2") }],
  ["documents/K-001.md", { ...base, doc_id: "K-001", title: "부동산 담보평가 실무 노하우", document_type: "KNOWHOW", index_group: "wiki-knowledge", effective_from: 20261101, effective_to: 99991231, content_hash: H("3"), business_path: ["여신", "담보"], tags: ["현장실사", "감정평가"] }],
  // 부서 B 전용 문서 (ACL 테스트)
  ["documents/K-004.md", { ...base, doc_id: "K-004", title: "재무제표 검토 시 체크 포인트", document_type: "KNOWHOW", index_group: "wiki-knowledge", acl_groups: ["DEPT#리스크"], effective_from: 20261101, effective_to: 99991231, content_hash: H("4") }],
];

function setup() {
  const retriever = new MemoryRetriever();
  const states = new MemoryDocStates();
  for (const [file, meta] of docs) {
    for (const c of chunkDocument(readFileSync(new URL(file, FIX), "utf8"), meta)) retriever.add(c.augmented_search_text, c.metadata);
    states.docs.set(meta.doc_id, { doc_id: meta.doc_id, lifecycle: "PUBLISHED", authority_status: "VERIFIED", freshness: "CURRENT", acl_groups: meta.acl_groups, published_content_hash: meta.content_hash });
  }
  const tools = searchTools({ retriever, states, regulation: regulationTools(fixtureClauseStore(), { today: () => 20261216 }) });
  return { retriever, states, tools };
}
const user = { sub: "u1", groups: ["USER"], dept: "여신" };

test("필터: 서버 주입 ACL(listContains), 그룹 1개면 orAll 없이 단일 조건", () => {
  const f = buildFilter({ sub: "x", groups: [] }, { asOf: 20261215 }) as unknown as { andAll: Record<string, unknown>[] };
  assert.deepEqual(f.andAll[0], { listContains: { key: "acl_groups", value: "ALL" } });
  const g = buildFilter(user, { asOf: 20261215 }) as unknown as { andAll: { orAll?: unknown[] }[] };
  assert.equal(g.andAll[0]!.orAll!.length, 3); // ALL, USER, DEPT#여신
  assert.ok(JSON.stringify(g).includes('"lessThanOrEquals":{"key":"effective_from","value":20261215}'));
});

test("search_wiki: 기준일 필터로 현행 버전만, 원문 인용, 보강 헤더 인용 금지", async () => {
  const { tools } = setup();
  const r = await tools.search_wiki({ query: "본부 여신심사위원회 승인 기준 금액", as_of: "2026-12-15" }, user);
  assert.equal(r.search_status, "FOUND");
  const reg = r.items.filter((x) => x.document_type === "REGULATION");
  assert.ok(reg.length > 0 && reg.every((x) => x.doc_id === "F-002"), "기준일 2026-12-15에는 v2만");
  assert.ok(r.items.every((x) => !x.snippet.startsWith("[")), "original_text에 헤더 없음");
  const old = await tools.search_wiki({ query: "본부 여신심사위원회 승인 기준 금액", as_of: "2026-11-15" }, user);
  assert.ok(old.items.filter((x) => x.document_type === "REGULATION").every((x) => x.doc_id === "F-001"));
});

test("ACL: 다른 부서 전용 문서는 노출 0건, 해당 부서는 조회 가능", async () => {
  const { tools } = setup();
  const q = { query: "매출채권 회전일 부실 징후", as_of: "2026-12-15" };
  assert.ok(!(await tools.search_wiki(q, user)).items.some((x) => x.doc_id === "K-004"));
  assert.ok((await tools.search_wiki(q, { sub: "u2", groups: ["USER"], dept: "리스크" })).items.some((x) => x.doc_id === "K-004"));
});

test("재검증: KB에 남은 청크라도 현재 상태가 PUBLISHED 아님·해시 불일치면 제외", async () => {
  const { tools, states } = setup();
  states.docs.get("K-001")!.lifecycle = "BLOCKED";
  states.docs.get("F-002")!.published_content_hash = H("9"); // 새 버전 게시 후 KB 동기화 전 상황
  const r = await tools.search_wiki({ query: "현장 실사 감정평가서 LTV", as_of: "2026-12-15" }, user);
  assert.ok(!r.items.some((x) => x.doc_id === "K-001" || x.doc_id === "F-002"));
  assert.ok(r.dropped_after_revalidation > 0);
});

test("결과 0건은 UNVERIFIED (부재 단정 금지), 질의 PII 마스킹", async () => {
  const { tools, retriever } = setup();
  const r = await tools.search_wiki({ query: "zzqx 010-1234-5678", as_of: "2026-12-15" }, user);
  assert.equal(r.search_status, "UNVERIFIED");
  assert.equal(r.pii_masked, true);
  assert.ok(!retriever.lastQuery.includes("010") && retriever.lastQuery.includes("[전화번호]"));
});

test("search_legal_clause: 조문 번호 질의는 Exact Lookup 먼저, 삭제 조항은 DELETED", async () => {
  const { tools } = setup();
  const r = await tools.search_legal_clause({ query: "한빛은행 기업여신 심사규정 제12조제1항 승인 기준", as_of: "2026-12-15" }, user);
  assert.equal(r.via, "exact_lookup");
  assert.equal(r.search_status, "FOUND");
  const d = await tools.search_legal_clause({ query: "기업여신 심사규정 제15조제2항", law: "한빛은행 기업여신 심사규정", as_of: "2026-12-15" }, user);
  assert.equal(d.search_status, "DELETED");
  const kb = await tools.search_legal_clause({ query: "담보인정비율 상한", as_of: "2026-12-15" }, user);
  assert.equal(kb.via, "kb_hybrid");
});

test("retrieve_evidence: 지정 문서 안에서만", async () => {
  const { tools } = setup();
  const r = await tools.retrieve_evidence({ query: "현장 실사", doc_ids: ["K-001"], as_of: "2026-12-15" }, user);
  assert.ok(r.items.length > 0 && r.items.every((x) => x.doc_id === "K-001"));
});

test("이전 버전 KB 메타데이터가 갱신되지 않아도 DynamoDB 현재 유효기간·SUPERSEDED로 차단, 이력 검색은 HISTORICAL", async () => {
  const { tools, states, retriever } = setup();
  // F-001 청크의 KB 메타데이터를 열린 기간으로 바꿔 '종료일 미갱신' 상황 재현
  for (const c of retriever.chunks) if (c.metadata["doc_id"] === "F-001") c.metadata["effective_to"] = 99991231;
  states.docs.get("F-001")!.effective_to = 20261130;
  const r = await tools.search_wiki({ query: "본부 여신심사위원회 승인 기준 금액", as_of: "2026-12-15", index_groups: ["legal-clauses"] }, user);
  assert.ok(!r.items.some((x) => x.doc_id === "F-001"));
  states.docs.get("F-002")!.freshness = "SUPERSEDED"; // 기간 정보 없이 SUPERSEDED
  const only = await tools.search_wiki({ query: "본부 여신심사위원회 승인 기준 금액", as_of: "2026-12-15", index_groups: ["legal-clauses"] }, user);
  assert.ok(!only.items.some((x) => x.doc_id === "F-002"));
  const hist = await tools.retrieve_evidence({ query: "LTV 가산", doc_ids: ["F-002"], as_of: "2026-12-15", include_history: true }, user);
  assert.equal(hist.search_status, "HISTORICAL");
});

test("응답 계약: dhxorb96 가이드 Agent Evidence 필드 (items, snippet, provision, YYYY-MM-DD, 항목별 search_status)", async () => {
  const { tools } = setup();
  const r = await tools.search_wiki({ query: "본부 여신심사위원회 승인 기준", as_of: "2026-12-15" }, user);
  const reg = r.items.find((x) => x.document_type === "REGULATION")!;
  assert.match(reg.provision!, /^한빛은행 기업여신 심사규정 제\d+조/u);
  assert.match(reg.effective_from, /^\d{4}-\d{2}-\d{2}$/u);
  assert.equal(reg.search_status, "FOUND");
  assert.ok(reg.snippet.length > 0 && !reg.snippet.startsWith("["));
  for (const k of ["doc_id", "title", "snippet", "authority_status", "freshness"] as const) assert.ok(k in reg, k);
  const know = r.items.find((x) => x.document_type === "KNOWHOW");
  if (know) assert.equal(know.provision, undefined);
});

test("노하우 본문 → 관련 현행 조문 상위 5 (dhxorb96 1924-2, 조문 번호 없는 노하우): G-KC-02 보유 기간", async () => {
  const { tools, retriever, states } = setup();
  const { readFileSync: rf } = await import("node:fs");
  // 개인정보 보호규정(G-REG-06) 색인
  const law = { ...base, doc_id: "G-REG-06", title: "한빛은행 개인정보 보호규정", law_name: "한빛은행 개인정보 보호규정", document_type: "REGULATION" as const, law_id: "SYN-PRIV-001", revision_id: "2026-11-01", effective_from: 20261101, effective_to: 99991231, content_hash: H("6") };
  for (const c of chunkDocument(rf(new URL("golden/G-REG-06.txt", FIX), "utf8"), law)) retriever.add(c.augmented_search_text, c.metadata);
  states.docs.set("G-REG-06", { doc_id: "G-REG-06", lifecycle: "PUBLISHED", authority_status: "VERIFIED", freshness: "CURRENT", acl_groups: ["ALL"], published_content_hash: H("6") });
  const body = rf(new URL("golden/G-KC-02.md", FIX), "utf8").replace(/^---\n[\s\S]*?\n---\n/u, "");
  const r = await tools.search_wiki({ query: body, index_groups: ["legal-clauses"], top_k: 5, as_of: "2026-12-15" }, user);
  assert.ok(r.items.some((x) => x.provision_id === "SYN-PRIV-001@2026-11-01/ARTICLE:5/PARAGRAPH:1"), r.items.map((x) => x.provision_id).join(", "));
  assert.ok(r.items.every((x) => x.document_type === "REGULATION"));
});

test("rerank 모델 접근 거부면 HYBRID로 대체, 다른 오류는 그대로 던짐", async () => {
  const { BedrockRetriever } = await import("./index.ts");
  type Cfg = { input: { retrievalConfiguration: { vectorSearchConfiguration: { rerankingConfiguration?: unknown } } } };
  const calls: boolean[] = [];
  const fake = (fail: Error) => ({ send: async (cmd: Cfg) => {
    const rerank = !!cmd.input.retrievalConfiguration.vectorSearchConfiguration.rerankingConfiguration;
    calls.push(rerank);
    if (rerank) throw fail;
    return { retrievalResults: [{ content: { text: "본문" }, score: 0.5, metadata: {} }] };
  } }) as unknown as ConstructorParameters<typeof BedrockRetriever>[2];
  const denied = Object.assign(new Error("Model access is denied due to ... aws-marketplace:Subscribe"), { name: "ValidationException" });
  const hits = await new BedrockRetriever("KB", "cohere.rerank-v3-5:0", fake(denied)).retrieve("q");
  assert.deepEqual(calls, [true, false]);
  assert.equal(hits[0]?.text, "본문");
  const other = Object.assign(new Error("Throttled"), { name: "ThrottlingException" });
  await assert.rejects(new BedrockRetriever("KB", "cohere.rerank-v3-5:0", fake(other)).retrieve("q"), /Throttled/u);
});

test("업무 분류·태그 필터: business_path·tags 메타데이터로 거르고 결과에 함께 반환", async () => {
  const { tools } = setup();
  const q = { query: "현장 실사 감정평가", as_of: "2026-12-15", top_k: 10 };
  const all = await tools.search_wiki(q, user);
  assert.ok(all.items.some((x) => x.doc_id !== "K-001"), "필터 없으면 규정도 나옴");
  const loan = await tools.search_wiki({ ...q, business: "여신" }, user);
  assert.ok(loan.items.length > 0 && loan.items.every((x) => x.doc_id === "K-001"));
  assert.deepEqual(loan.items[0]!.business_path, ["여신", "담보"]);
  assert.deepEqual(loan.items[0]!.tags, ["현장실사", "감정평가"]);
  assert.ok((await tools.search_wiki({ ...q, tags: ["없는태그", "감정평가"] }, user)).items.every((x) => x.doc_id === "K-001"));
  assert.equal((await tools.search_wiki({ ...q, business: "외환" }, user)).items.length, 0);
});
