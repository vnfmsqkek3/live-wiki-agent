import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chunkDocument } from "@hanaeum/kb-chunker";
import { regulationTools } from "@hanaeum/regulation-server";
import { fixtureClauseStore } from "../../regulation-server/src/fixtures.ts";
import type { DocumentMetadata } from "@hanaeum/schemas";
import { buildFilter, inCategory, searchTools, MemoryRetriever, MemoryDocStates } from "./index.ts";

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
