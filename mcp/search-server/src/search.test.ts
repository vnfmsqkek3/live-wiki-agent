import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chunkDocument } from "@hanaeum/kb-chunker";
import { regulationTools } from "@hanaeum/regulation-server";
import { fixtureClauseStore } from "../../regulation-server/src/fixtures.ts";
import type { DocumentMetadata } from "@hanaeum/schemas";
import type { DocState, DocStates } from "./search.ts";
import { createHash } from "node:crypto";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
import { buildFilter, inCategory, searchTools, MemoryRetriever, MemoryDocStates } from "./index.ts";
import type { RetrievalFilter } from "@aws-sdk/client-bedrock-agent-runtime";

const FIX = new URL("../../../tests/fixtures/", import.meta.url);
const H = (c: string) => "sha256:" + c.repeat(64);
const base = { index_group: "legal-clauses" as const, authority_status: "VERIFIED" as const, freshness: "CURRENT" as const, lifecycle: "PUBLISHED" as const, acl_groups: ["ALL"], dept: "여신", approval_id: "apr_1" };
const docs: [string, DocumentMetadata][] = [
  ["documents/F-001.txt", { ...base, doc_id: "F-001", title: "하나은행 기업여신 심사규정", law_name: "하나은행 기업여신 심사규정", document_type: "REGULATION", law_id: "SYN-LOAN-001", revision_id: "2026-11-01", effective_from: 20261101, effective_to: 20261130, content_hash: H("1") }],
  ["documents/F-002.txt", { ...base, doc_id: "F-002", title: "하나은행 기업여신 심사규정", law_name: "하나은행 기업여신 심사규정", document_type: "REGULATION", law_id: "SYN-LOAN-001", revision_id: "2026-12-01", effective_from: 20261201, effective_to: 99991231, content_hash: H("2") }],
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
  // 0건: 어떤 문서와도 겹치지 않는 질의 (로컬 KB 에뮬레이터는 글자 두 개 단위로 점수를 매겨 "[주민등록번호]"도 개인정보 규정과 겹친다)
  assert.equal((await tools.search_wiki({ query: "zzqx qqzz", as_of: "2026-12-15" }, user)).search_status, "UNVERIFIED");
  const r = await tools.search_wiki({ query: "zzqx 900101-1234568", as_of: "2026-12-15" }, user);
  assert.equal(r.pii_masked, true);
  assert.ok(!retriever.lastQuery.includes("1234568") && retriever.lastQuery.includes("[주민등록번호]"));
});

test("search_legal_clause: 조문 번호 질의는 Exact Lookup 먼저, 삭제 조항은 DELETED", async () => {
  const { tools } = setup();
  const r = await tools.search_legal_clause({ query: "하나은행 기업여신 심사규정 제12조제1항 승인 기준", as_of: "2026-12-15" }, user);
  assert.equal(r.via, "exact_lookup");
  assert.equal(r.search_status, "FOUND");
  const d = await tools.search_legal_clause({ query: "기업여신 심사규정 제15조제2항", law: "하나은행 기업여신 심사규정", as_of: "2026-12-15" }, user);
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
  assert.match(reg.provision!, /^하나은행 기업여신 심사규정 제\d+조/u);
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
  const law = { ...base, doc_id: "G-REG-06", title: "하나은행 개인정보 보호규정", law_name: "하나은행 개인정보 보호규정", document_type: "REGULATION" as const, law_id: "SYN-PRIV-001", revision_id: "2026-11-01", effective_from: 20261101, effective_to: 99991231, content_hash: H("6") };
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

test("그림 묘사 청크는 검색되지만 quotable=false, 스니펫에 '원문 아님' 표시", async () => {
  const { retriever, states, tools } = setup();
  retriever.add("[부동산 담보평가 실무 노하우 · 그림 (1쪽)]\n표: 현장 실사 체크리스트 사진", { ...docs[2]![1], provision_id: "K-001#fig0", provision_path: "그림 (1쪽)", provision_status: "ACTIVE", parent_id: "K-001", source_page: 0, original_text: "", has_figure: true });
  void states;
  const r = await tools.search_wiki({ query: "현장 실사 체크리스트 사진", as_of: "2026-12-15", top_k: 10 }, user);
  const fig = r.items.find((x) => x.provision_id === "K-001#fig0")!;
  assert.equal(fig.quotable, false);
  assert.match(fig.snippet, /^\[그림 설명 · 원문 아님\] 표: 현장 실사 체크리스트 사진$/u);
  assert.ok(r.items.filter((x) => x.provision_id !== "K-001#fig0").every((x) => x.quotable));
});

test("Rerank 관련도: 1위 게이트(0.30) + 1위 대비 40% (실측 보정)", async () => {
  const { BedrockRetriever } = await import("./index.ts");
  const fake = (scores: number[]) => ({ send: async () => ({ retrievalResults: scores.map((score, i) => ({ content: { text: `t${i}` }, score, metadata: {} })) }) }) as unknown as ConstructorParameters<typeof BedrockRetriever>[2];
  const r = (s: number[]) => new BedrockRetriever("KB", "cohere.rerank-v3-5:0", fake(s)).retrieve("q");
  assert.deepEqual((await r([0.536, 0.233, 0.125])).map((h) => h.score), [0.536, 0.233], "개인정보 수집: 정의 조문은 남고 잡음은 빠짐");
  assert.ok((await r([0.248, 0.2])).every((h) => h.weak), "1위 0.30 미만 → 근거 아님(weak, related로만)");
  assert.deepEqual(await r([0.094, 0.06]), [], "1위 0.10 미만 → 관련 문서도 없음 (무관 질의 실측 0.017~0.094)");
  assert.equal((await new BedrockRetriever("KB", undefined, fake([0.01])).retrieve("q")).length, 1, "Rerank 없으면 미적용");
});

test("세부 필터(11/17): 부서·문서 일자 기간은 KB 필터, 잘못된 인자는 INVALID_ARGUMENT", async () => {
  const f = buildFilter({ sub: "x", groups: ["USER"] }, { asOf: 20261215, dept: "여신", dateFrom: 20260101, dateTo: 20261231 }) as unknown as { andAll: Record<string, unknown>[] };
  const s = JSON.stringify(f.andAll);
  assert.ok(s.includes('{"equals":{"key":"dept","value":"여신"}}'));
  assert.ok(s.includes('{"greaterThanOrEquals":{"key":"doc_date","value":20260101}}') && s.includes('{"lessThanOrEquals":{"key":"doc_date","value":20261231}}'));
  const t = searchTools({ retriever: new MemoryRetriever(), states: new MemoryDocStates(), regulation: regulationTools(fixtureClauseStore(), { today: () => 20261216 }) });
  await assert.rejects(t.search_wiki({ query: "q", date_from: "2026/01/01" }, { sub: "x", groups: ["USER"] }), { name: "ToolError", message: /date_from/u });
  await assert.rejects(t.search_wiki({ query: "q", freshness: "OLD" }, { sub: "x", groups: ["USER"] }), { message: /freshness/u });
  await assert.rejects(t.search_wiki({ query: "q", date_from: "2026-13-45" }, { sub: "x", groups: ["USER"] }), { message: /date_from/u });
  await assert.rejects(t.search_wiki({ query: "q", date_from: "2026-12-01", date_to: "2026-01-01" }, { sub: "x", groups: ["USER"] }), { message: /늦음/u });
});

test("근거 기준 미달(weak) 결과는 UNVERIFIED + related(참고)로만 — 단정하지 않되 버리지도 않음 (11/17 '개인정보 수집' 실측)", async () => {
  const { retriever, states } = setup();
  const weak = { retrieve: async (q: string, f?: Parameters<typeof retriever.retrieve>[1]) => (await retriever.retrieve(q, f)).map((h) => ({ ...h, weak: true })) };
  const t = searchTools({ retriever: weak, states, regulation: regulationTools(fixtureClauseStore(), { today: () => 20261216 }) });
  const r = await t.search_wiki({ query: "본부 여신심사위원회 승인 기준 금액", as_of: "2026-12-15" }, user) as { search_status: string; items: unknown[]; related?: { doc_id: string }[] };
  assert.equal(r.search_status, "UNVERIFIED");
  assert.equal(r.items.length, 0, "근거(items)로는 쓰지 않음");
  assert.ok(r.related && r.related.length > 0, "관련 가능 문서로는 보여 줌");
});

test("search_wiki 질의 재구성: rewritten·matched_query 응답, rewrite=false면 원문 그대로, 모델 입력은 마스킹본", async () => {
  const { tools, retriever, states } = setup();
  const seen: string[] = [];
  const t2 = searchTools({ retriever, states, regulation: regulationTools(fixtureClauseStore(), { today: () => 20261216 }),
    rewriter: { rewrite: async (q) => { seen.push(q); return { core: "본부 여신심사위원회 승인 기준", alternates: ["여신심사위원회 승인 금액"] }; } } });
  const r = await t2.search_wiki({ query: "900101-1234568 본부 여신심사위원회 승인 기준 알려줘", as_of: "2026-12-15" }, user) as { rewritten?: unknown; items: { matched_query?: string }[] };
  assert.ok(!seen[0]!.includes("1234568") && seen[0]!.includes("[주민등록번호]"));
  assert.deepEqual(r.rewritten, { core: "본부 여신심사위원회 승인 기준", alternates: ["여신심사위원회 승인 금액"] });
  assert.ok(r.items.length && r.items.every((i) => ["본부 여신심사위원회 승인 기준", "여신심사위원회 승인 금액"].includes(i.matched_query!)));
  const raw = await t2.search_wiki({ query: "본부 여신심사위원회 승인 기준 알려줘", as_of: "2026-12-15", rewrite: false }, user) as { rewritten?: unknown };
  assert.equal(raw.rewritten, undefined);
  assert.equal(retriever.lastQuery, "본부 여신심사위원회 승인 기준 알려줘");
  // 모델 없으면 규칙만
  const r3 = await tools.search_wiki({ query: "본부 여신심사위원회 승인 기준 알려줘", as_of: "2026-12-15" }, user) as { rewritten?: unknown };
  assert.deepEqual(r3.rewritten, { core: "본부 여신심사위원회 승인 기준", alternates: [] });
});

test("업무 분류 필터 (interfaces 10.1): 하위 포함 KB 필터 + 현재 분류로 다시 거름(재분류·병합 뒤 낡은 메타데이터 차단)", async () => {
  const f = JSON.stringify(buildFilter(user, { asOf: 20261215, category: "여신" }));
  assert.ok(f.includes('"equals":{"key":"category_path","value":"여신"}') && f.includes('"startsWith":{"key":"category_path","value":"여신/"}'));
  const { retriever, states } = setup();
  for (const c of retriever.chunks) if (c.metadata["doc_id"] === "F-002") c.metadata["category_path"] = "여신/기업여신";
  for (const c of retriever.chunks) if (c.metadata["doc_id"] === "K-001") c.metadata["category_path"] = "여신/담보·감정평가";
  // 현재 분류: K-001은 그 뒤 '수신'으로 재분류됨
  const cur = new Map([["F-002", "여신/기업여신"], ["K-001", "수신/창구·현금"]]);
  const t = searchTools({ retriever, states: Object.assign(states, { categoryPaths: async (ids: string[]) => new Map(ids.flatMap((i) => (cur.has(i) ? [[i, cur.get(i)!] as [string, string]] : []))) }), regulation: regulationTools(fixtureClauseStore(), { today: () => 20261216 }) });
  const r = await t.search_wiki({ query: "본부 여신심사위원회 승인 기준 담보 감정평가", as_of: "2026-12-15", category: "여신", rewrite: false }, user);
  const all = [...r.items, ...(r.related ?? [])];
  assert.ok(all.length && all.every((x) => x.doc_id === "F-002" && x.category_path === "여신/기업여신"));
  // "여신"이 "여신심사" 같은 다른 칸 이름의 앞부분일 때 섞이지 않음
  assert.equal(inCategory("여신심사/기타", "여신"), false);
  assert.equal(inCategory("여신", "여신"), true);
  await assert.rejects(t.search_wiki({ query: "x", category: "가".repeat(201) }, user), /category/u);
  for (const bad of [123, "/", " / "]) await assert.rejects(t.search_wiki({ query: "x", category: bad }, user), /category/u);
});

test("업무 분류: 현재 분류의 doc_id로 KB를 거르므로 재분류·병합된 문서도 새 분류에서 찾음 (PR #32 리뷰)", async () => {
  const { retriever, states } = setup();
  // K-001의 색인 시점 경로는 옛 칸, 현재는 '여신/담보·감정평가'로 병합됨
  for (const c of retriever.chunks) if (c.metadata["doc_id"] === "K-001") c.metadata["category_path"] = "여신/담보";
  const cur = new Map([["K-001", "여신/담보·감정평가"]]);
  const st = Object.assign(states, {
    categoryDocIds: async (cat: string) => [...cur].filter(([, p]) => inCategory(p, cat)).map(([d]) => d),
    categoryPaths: async (ids: string[]) => new Map(ids.flatMap((i) => (cur.has(i) ? [[i, cur.get(i)!] as [string, string]] : []))),
  });
  const t = searchTools({ retriever, states: st, regulation: regulationTools(fixtureClauseStore(), { today: () => 20261216 }) });
  const r = await t.search_wiki({ query: "담보 감정평가 현장 실사", as_of: "2026-12-15", category: "여신/담보·감정평가", rewrite: false }, user);
  const all = [...r.items, ...(r.related ?? [])];
  assert.ok(all.length && all.every((x) => x.doc_id === "K-001" && x.category_path === "여신/담보·감정평가"));
  // 분류에 문서가 하나도 없으면 KB를 부르지 않고 확인 불가
  const empty = await t.search_wiki({ query: "담보", as_of: "2026-12-15", category: "카드", rewrite: false }, user);
  assert.equal(empty.search_status, "UNVERIFIED");
  assert.equal(empty.items.length, 0);
});

test("결과 항목 page: 근거 조각의 쪽 (1부터, 청크 source_page + 1)", async () => {
  const { tools, retriever } = setup();
  for (const c of retriever.chunks) if (c.metadata["doc_id"] === "F-002") c.metadata["source_page"] = 2;
  const r = await tools.search_wiki({ query: "본부 여신심사위원회 승인 기준 금액", as_of: "2026-12-15", rewrite: false }, user);
  const f2 = [...r.items, ...(r.related ?? [])].filter((x) => x.doc_id === "F-002");
  assert.ok(f2.length && f2.every((x) => x.page === 3));
});

test("그림 기준 근거(evidence_kind FIGURE)는 인용 가능·머리표, page_context 전달", async () => {
  const { tools, retriever } = setup();
  const c0 = retriever.chunks.find((c) => c.metadata["doc_id"] === "K-001")!;
  retriever.add("[부동산 담보평가 실무 노하우 · 그림 (2쪽)]\n감정평가 현장 실사 화면 절차", { ...c0.metadata, provision_id: "K-001#fig0", has_figure: true, evidence_kind: "FIGURE", original_text: "감정평가 현장 실사 화면 절차", page_context: "01 실사 › 그림 1: 현장", source_page: 1 });
  const r = await tools.search_wiki({ query: "감정평가 현장 실사 화면 절차", as_of: "2026-12-15", rewrite: false }, user);
  const f = [...r.items, ...(r.related ?? [])].find((x) => x.provision_id === "K-001#fig0")!;
  assert.equal(f.quotable, true);
  assert.equal(f.evidence_kind, "FIGURE");
  assert.match(f.snippet, /^\[그림 기준 · AI 정리\] 감정평가/u);
  assert.equal(f.page_context, "01 실사 › 그림 1: 현장");
});

test("규정 문서에 evidence_kind가 남아 있어도 그림 기준 근거로 인용되지 않음 (PR #42 리뷰)", async () => {
  const { tools, retriever } = setup();
  const reg = retriever.chunks.find((c) => c.metadata["doc_id"] === "F-002")!.metadata;
  retriever.add("[규정 · 그림 (1쪽)]\n본부 여신심사위원회 승인 기준 금액 요약", { ...reg, provision_id: "F-002#fig0", has_figure: true, evidence_kind: "FIGURE", original_text: "요약" });
  const r = await tools.search_wiki({ query: "본부 여신심사위원회 승인 기준 금액 요약", as_of: "2026-12-15", rewrite: false }, user);
  const f = [...r.items, ...(r.related ?? [])].find((x) => x.provision_id === "F-002#fig0");
  assert.ok(f && f.quotable === false && f.evidence_kind === undefined);
});

test("expand section: 걸린 조각의 같은 장 조각을 쪽 순서로 함께 (재검증 통과분만, 장당 8개)", async () => {
  const { retriever, states } = setup();
  const base = retriever.chunks.find((c) => c.metadata["doc_id"] === "K-001")!.metadata;
  const sec = { section: "02 삼성 복합기 드라이버", section_pages: "11-16" };
  retriever.add("[매뉴얼] 1. 다운로드 자료실 접속 드라이버 설치", { ...base, ...sec, provision_id: "K-001#p11", source_page: 11, original_text: "1. 다운로드 자료실 접속" });
  retriever.add("[매뉴얼] 3. 압축 해제 후 설치", { ...base, ...sec, provision_id: "K-001#p13", source_page: 13, original_text: "3. 압축 해제 후 설치" });
  retriever.add("[매뉴얼] 2. 모델명 입력", { ...base, ...sec, provision_id: "K-001#p12", source_page: 12, original_text: "2. 모델명 입력" });
  retriever.add("[매뉴얼 · 그림] 다운로드 화면", { ...base, ...sec, provision_id: "K-001#p11fig", source_page: 11, has_figure: true, original_text: "" });
  retriever.add("[매뉴얼] 13쪽 둘째", { ...base, ...sec, provision_id: "K-001#p13s10", source_page: 13, original_text: "13쪽 둘째" });
  retriever.add("[매뉴얼] 다른 장", { ...base, section: "03 신도", section_pages: "17-21", provision_id: "K-001#p17", source_page: 17, original_text: "다른 장" });
  const t = searchTools({ retriever, states, regulation: regulationTools(fixtureClauseStore(), { today: () => 20261216 }) });
  const r = await t.search_wiki({ query: "다운로드 자료실 접속 드라이버 설치", as_of: "2026-12-15", rewrite: false, expand: "section" }, user) as { expanded?: { section: string; section_pages?: string; items: { provision_id: string; page?: number }[] }[] };
  const e = r.expanded!.find((x) => x.section === "02 삼성 복합기 드라이버")!;
  assert.equal(e.section_pages, "11-16");
  assert.deepEqual(e.items.map((i) => i.provision_id), ["K-001#p11", "K-001#p12", "K-001#p13", "K-001#p13s10"]); // 쪽·숫자 순서, 다른 장·인용 불가 그림 제외
  await assert.rejects(t.search_wiki({ query: "x", expand: "all" }, user), /expand/u);
});

test("related 하한 (PR #44 리뷰): Rerank 1위가 근거 미달이면 0.10 미만 조각은 숨김, HYBRID 대체(재정렬 없음)는 하한 미적용", async () => {
  const { BedrockRetriever } = await import("./search.ts");
  const mk = (rerankScores: number[] | Error) => {
    const r = new BedrockRetriever("kb", "arn:rerank");
    (r as unknown as { c: { send: (cmd: { input: { retrievalConfiguration: { vectorSearchConfiguration: { rerankingConfiguration?: unknown } } } }) => Promise<unknown> } }).c = {
      send: async (cmd) => {
        const rr = !!cmd.input.retrievalConfiguration.vectorSearchConfiguration.rerankingConfiguration;
        if (rr && rerankScores instanceof Error) throw rerankScores;
        const sc = rr ? rerankScores as number[] : [0.02, 0.01];
        return { retrievalResults: sc.map((score, i) => ({ score, content: { text: `t${i}` }, metadata: { provision_id: `p${i}` } })) };
      },
    };
    return r;
  };
  const weak = await mk([0.25, 0.11, 0.09]).retrieve("q");
  assert.deepEqual(weak.map((h) => [h.metadata["provision_id"], h.weak]), [["p0", true], ["p1", true]]);
  const fallback = await mk(Object.assign(new Error("no model access"), { name: "AccessDeniedException" })).retrieve("q");
  assert.equal(fallback.length, 2); // 대체 경로는 점수 체계가 달라 하한 없음
});

test("get_wiki_document: 게시본을 쪽별로 (본문 TEXT, 글자 없는 캡처 쪽은 AI 정리본 VISION), 권한·게시 상태·게시 해시 확인", async () => {
  const { retriever } = setup();
  const DOC = "doc_01KAAAAAAAAAAAAAAAAAAAAAAA";
  const content = ["1쪽 본문\n| 층 | 모델 |\n|---|---|\n| 4층 | N620 |", "\f", "[그림 1]", "⟦그림 p0⟧ 그림 1 속 글자: 4층", "⟦그림 p0⟧ 쪽 정리(AI, 그림 기준): 4층 평면도", "⟦그림 p1⟧ 쪽 정리(AI, 그림 기준): 설치 완료 화면"].join("\n");
  const st = { doc_id: DOC, lifecycle: "PUBLISHED", authority_status: "UNVERIFIED", freshness: "CURRENT", acl_groups: ["ALL"], published_content_hash: sha("CONTENT"), version: 2, effective_from: 20260101, effective_to: 99991231 } as DocState;
  const s2 = { get: async (ids: string[]) => new Map(ids.includes(DOC) ? [[DOC, st]] : []) } as unknown as DocStates;
  const meta: Record<string, unknown> = { title: "과천 매뉴얼", document_type: "MANUAL", category_path: "총무/사무기기" };
  st.published_content_hash = `sha256:${sha(content)}`; // Promote 가 기록하는 실제 형식
  let body = content;
  const t = searchTools({ retriever, states: s2, regulation: regulationTools(fixtureClauseStore()), published: { get: async () => ({ content: body, meta }) } });
  const r = await t.get_wiki_document({ doc_id: DOC }, user) as unknown as { version: number; category_path: string; page_count: number; pages: { page: number; markdown: string; source: string; ai_summary?: string }[] };
  assert.equal(r.version, 2); assert.equal(r.category_path, "총무/사무기기"); assert.equal(r.page_count, 2);
  assert.deepEqual(r.pages[0], { page: 1, markdown: "1쪽 본문\n| 층 | 모델 |\n|---|---|\n| 4층 | N620 |", source: "TEXT", ai_summary: "4층 평면도" });
  assert.deepEqual(r.pages[1], { page: 2, markdown: "설치 완료 화면", source: "VISION" }); // 그림 속 글자 줄은 안 나감
  body = content + "\n새 버전"; // 게시 도중(본문 해시가 기록과 다름)
  await assert.rejects(t.get_wiki_document({ doc_id: DOC }, user), /없거나/u);
  body = content;
  // 폐지된 문서는 기본 제외, include_history면 historical
  st.effective_to = 20260601;
  await assert.rejects(t.get_wiki_document({ doc_id: DOC, as_of: "2026-12-01" }, user), /없거나/u);
  assert.equal((await t.get_wiki_document({ doc_id: DOC, as_of: "2026-12-01", include_history: true }, user) as { historical?: boolean }).historical, true);
  st.effective_to = 99991231;
  // 이어 받기
  assert.deepEqual((await t.get_wiki_document({ doc_id: DOC, from_page: 2 }, user) as unknown as { pages: { page: number }[] }).pages.map((p) => p.page), [2]);
  st.acl_groups = ["DEPT#수신"];
  await assert.rejects(t.get_wiki_document({ doc_id: DOC }, user), /없거나/u); // 권한 없음도 같은 응답
  st.acl_groups = ["ALL"]; st.lifecycle = "IN_REVIEW" as DocState["lifecycle"];
  await assert.rejects(t.get_wiki_document({ doc_id: DOC }, user), /없거나/u);
  await assert.rejects(t.get_wiki_document({ doc_id: "../x" }, user), /doc_id/u);
});

test("docPages: 상한을 넘으면 next_page, 한 쪽이 상한보다 길면 잘라서라도 (PR #45 리뷰)", async () => {
  const { docPages } = await import("./search.ts");
  const big = "가".repeat(50_000);
  const r = docPages([big, "\f", "둘째 쪽 본문입니다"].join("\n"));
  assert.equal(r.pages.length, 1); assert.equal(r.pages[0]!.cut, true); assert.equal(r.next_page, 2);
  assert.equal(docPages([big, "\f", "둘째 쪽 본문입니다"].join("\n"), 2).pages[0]!.markdown, "둘째 쪽 본문입니다");
});

test("related: 질의 핵심어가 없는 조각·그림 설명 조각은 '관련 가능 문서'로 내지 않음 (yoyo0704 실측 11/18)", async () => {
  const { queryTerms, hasTerm } = await import("./search.ts");
  const terms = queryTerms("개인정보 관련된 문서를 찾아줘 개인정보");
  assert.deepEqual(terms, ["개인정보"]);
  assert.equal(hasTerm("브라더 MFC-L5700DN 다운로드 페이지 전체 드라이버", ["개인정보"]), false);
  assert.deepEqual(queryTerms("개인정보에서 [전화번호] MFC"), ["개인정보", "mfc"]); // 조사·가림 표시 제거, 소문자
  assert.equal(hasTerm("성명 [개인정보] 연락처", ["개인정보"]), false); // 가림 표시는 핵심어로 안 침
  assert.equal(hasTerm("개인 정보 수집 동의서", ["개인정보"]), true); // 띄어쓰기 무시
  assert.equal(hasTerm("[개인정보 보호법]제15조제1항에 따라", ["개인정보"]), true); // 대괄호 법령명은 가림 표시가 아님
  assert.equal(hasTerm("MFC-L5700DN 드라이버", ["mfc"]), true);
  assert.equal(hasTerm("아무 글", []), true);
});

test("related 통합 (PR #46 리뷰): 핵심어 없는 조각·그림 설명(인용 불가) 조각은 빠지고, 핵심어 있는 조각만 남음 (rewrite=false)", async () => {
  const { retriever, states } = setup();
  const c0 = retriever.chunks.find((c) => c.metadata["doc_id"] === "K-001")!;
  retriever.add("[매뉴얼 · 그림 (3쪽)]\n개인정보 다운로드 페이지 화면", { ...c0.metadata, provision_id: "K-001#fig9", has_figure: true, original_text: "" });
  const weak = { retrieve: async (q: string, f?: Parameters<typeof retriever.retrieve>[1]) => (await retriever.retrieve(q, f)).map((h) => ({ ...h, weak: true })) };
  const t = searchTools({ retriever: weak, states, regulation: regulationTools(fixtureClauseStore(), { today: () => 20261216 }) });
  const r = await t.search_wiki({ query: "본부 여신심사위원회 개인정보", as_of: "2026-12-15", rewrite: false }, user) as { related?: { provision_id: string; snippet: string; title: string }[] };
  assert.ok(r.related?.length, "핵심어 있는 조각은 남음");
  assert.ok(r.related!.every((x) => x.provision_id !== "K-001#fig9"), "그림 설명은 관련 문서로 안 나감");
  assert.ok(r.related!.every((x) => /여신심사위원회|본부|개인정보/u.test(`${x.title} ${x.snippet}`.replace(/\s+/gu, ""))));
});

test("search_wiki 표시 순서: 재검토 필요 문서는 −0.10 — 점수 차 작으면 현행 규정이 위, 0.1 넘게 앞서면 그대로 (총괄 11/23)", async () => {
  const { retriever, states } = setup();
  const kh = [...states.docs.values()].find((d) => d.doc_id.startsWith("K-"))!.doc_id;
  states.docs.set(kh, { ...states.docs.get(kh)!, freshness: "REVIEW_REQUIRED" });
  // 노하우 점수 = 규정 1위 + gap (규정끼리 순서는 그대로)
  const withGap = (gap: number) => ({ retrieve: async (q: string, f?: RetrievalFilter) => {
    const hs = await retriever.retrieve(q, f);
    const reg = Math.max(...hs.filter((h) => h.metadata["doc_id"] !== kh).map((h) => h.score));
    return hs.map((h) => (h.metadata["doc_id"] === kh ? { ...h, score: reg + gap } : h));
  } });
  const ask = async (gap: number) => (await searchTools({ retriever: withGap(gap), states, regulation: regulationTools(fixtureClauseStore(), { today: () => 20261216 }) })
    .search_wiki({ query: "본부 여신심사위원회 승인 기준 금액", as_of: "2026-12-15", rewrite: false }, user) as unknown as { items: { doc_id: string; freshness: string; score: number }[] }).items;
  const near = await ask(0.05);
  assert.ok(near.some((x) => x.doc_id === kh), "재검토 노하우도 근거에 남음(판정 그대로)");
  assert.notEqual(near[0]!.doc_id, kh, "점수 차 0.05면 현행 규정이 1위");
  assert.ok(near[0]!.score < near.find((x) => x.doc_id === kh)!.score, "점수는 원래 값 그대로 내보냄");
  const far = await ask(0.15);
  assert.equal(far[0]!.doc_id, kh, "0.1 넘게 앞서면 재검토 노하우가 그대로 1위");
});

test("search_wiki: 얕은 근거(1위 < 기준+0.05)여도 삭제 항이 질의에 맞으면 같은 조 현행 항을 앞에 (CT-04 경계, 총괄 11/23)", async () => {
  const { retriever, states } = setup();
  // prod 11/23 실측: 현행 검색 1위가 다른 조 0.32(기준 0.30 바로 위) → 근거 있음이라 이력 보충이 안 돌아 제15조제1항이 관련(weak)에만
  const current = (f?: RetrievalFilter) => JSON.stringify(f ?? {}).includes("effective_to");
  const art15 = (h: { metadata: Record<string, unknown> }) => String(h.metadata["provision_id"]).includes("/ARTICLE:15");
  const stub = { retrieve: async (q: string, f?: RetrievalFilter) => (await retriever.retrieve(q, f)).map((h) => (!current(f) ? h : art15(h) ? { ...h, weak: true } : { ...h, score: 0.32 })) };
  const t = searchTools({ retriever: stub, states, regulation: regulationTools(fixtureClauseStore(), { today: () => 20261216 }) });
  const r = await t.search_wiki({ query: "신용등급 A 차주 LTV 가산", as_of: "2026-12-15", rewrite: false }, user) as unknown as { items: { provision_id: string; replaces?: string }[] };
  assert.ok(r.items.some((x) => !x.provision_id.includes("/ARTICLE:15")), "얕은 근거가 실제로 있는 상황: " + JSON.stringify(r.items.map((x) => x.provision_id)));
  assert.equal(r.items[0]!.provision_id, "SYN-LOAN-001@2026-12-01/ARTICLE:15/PARAGRAPH:1");
  assert.equal(r.items[0]!.replaces, "SYN-LOAN-001@2026-11-01/ARTICLE:15/PARAGRAPH:2");
  assert.ok(!r.items.some((x) => x.provision_id.startsWith("SYN-LOAN-001@2026-11-01")));
  // 1위가 충분히 높으면(기준+0.05 이상) 지금처럼 이력 검색 안 함
  const strong = { retrieve: async (q: string, f?: RetrievalFilter) => (await retriever.retrieve(q, f)).map((h) => (!current(f) ? h : art15(h) ? { ...h, weak: true } : { ...h, score: 0.6 })) };
  const t2 = searchTools({ retriever: strong, states, regulation: regulationTools(fixtureClauseStore(), { today: () => 20261216 }) });
  const r2 = await t2.search_wiki({ query: "신용등급 A 차주 LTV 가산", as_of: "2026-12-15", rewrite: false }, user) as unknown as { items: { replaces?: string }[] };
  assert.ok(r2.items.every((x) => !x.replaces));
});

test("search_wiki: 삭제된 항이 질의에 맞으면 같은 조 현행 항을 근거로 (데이터QA CT-04 11/20), 삭제 항은 내보내지 않음", async () => {
  const { retriever, states } = setup();
  // prod 실측 재현: 현행만 찾으면 제15조제1항 0.289(근거 기준 미달=weak), 이력 포함이면 삭제된 F-001 제15조제2항 0.785
  const current = (f?: RetrievalFilter) => JSON.stringify(f ?? {}).includes("effective_to");
  const stub = { retrieve: async (q: string, f?: RetrievalFilter) => (await retriever.retrieve(q, f)).map((h) => (current(f) ? { ...h, weak: true } : h)) };
  const t = searchTools({ retriever: stub, states, regulation: regulationTools(fixtureClauseStore(), { today: () => 20261216 }) });
  const r = await t.search_wiki({ query: "신용등급 A 차주 LTV 가산", as_of: "2026-12-15" }, user) as unknown as { search_status: string; items: { provision_id: string; replaces?: string }[]; related?: { provision_id: string }[] };
  assert.equal(r.search_status, "FOUND");
  assert.ok(r.items.length > 0 && r.items.every((x) => x.provision_id.startsWith("SYN-LOAN-001@2026-12-01/ARTICLE:15")), JSON.stringify(r.items.map((x) => x.provision_id)));
  assert.ok(r.items.some((x) => x.provision_id === "SYN-LOAN-001@2026-12-01/ARTICLE:15/PARAGRAPH:1"));
  assert.equal(r.items[0]!.replaces, "SYN-LOAN-001@2026-11-01/ARTICLE:15/PARAGRAPH:2");
  assert.ok(![...r.items, ...(r.related ?? [])].some((x) => x.provision_id.startsWith("SYN-LOAN-001@2026-11-01")), "삭제·과거 항은 근거·참고 어디에도 없음");
  // 이력 포함 검색에서도 근거 기준 미달(옛 항도 질의와 무관)이면 보충하지 않음: 근거 없음 그대로
  const allWeak = { retrieve: async (q: string, f?: RetrievalFilter) => (await retriever.retrieve(q, f)).map((h) => ({ ...h, weak: true })) };
  const t2 = searchTools({ retriever: allWeak, states, regulation: regulationTools(fixtureClauseStore(), { today: () => 20261216 }) });
  const r2 = await t2.search_wiki({ query: "신용등급 A 차주 LTV 가산", as_of: "2026-12-15" }, user) as unknown as { search_status: string; items: unknown[] };
  assert.equal(r2.search_status, "UNVERIFIED"); assert.equal(r2.items.length, 0);
});
