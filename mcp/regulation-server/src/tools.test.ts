import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHandler } from "@hanaeum/mcp-kit";
import { regulationTools, clausePath } from "./tools.ts";
import { fixtureClauseStore } from "./fixtures.ts";

const user = { sub: "u1", groups: ["USER"] };
const t = regulationTools(fixtureClauseStore(), { today: () => 20261216 });
const LAW = "하나은행 기업여신 심사규정";

test("조문 표현 해석", () => {
  assert.equal(clausePath("제12조제2항제3호가목"), "ARTICLE:12/PARAGRAPH:2/ITEM:3/SUBITEM:GA");
  assert.equal(clausePath("제12조의2"), "ARTICLE:12-2");
  assert.equal(clausePath("제 12 조 제 1 항"), "ARTICLE:12/PARAGRAPH:1");
  assert.equal(clausePath("SYN-LOAN-001@2026-11-01/ARTICLE:12/PARAGRAPH:1"), "ARTICLE:12/PARAGRAPH:1");
  assert.throws(() => clausePath("승인 기준"));
});

test("FOUND: 기준일에 시행 중인 버전의 현행 조문", async () => {
  const r = await t.get_clause({ law: LAW, clause: "제12조제1항", as_of: "2026-12-15" }, user);
  assert.equal(r.search_status, "FOUND");
  assert.equal(r.revision_id, "2026-12-01");
  assert.match(r.original_text!, /3억원/u);
});

test("HISTORICAL: 과거 기준일 질의는 당시 버전 + 과거 표시", async () => {
  const r = await t.get_clause({ law: LAW, clause: "제12조제1항", as_of: "2025-06-01" }, user);
  assert.equal(r.search_status, "HISTORICAL");
  assert.match(r.original_text!, /7억원/u);
  const gone = await t.get_clause({ law: LAW, clause: "제16조", as_of: "2026-12-15" }, user);
  assert.equal(gone.search_status, "HISTORICAL"); // 현행에 없고 v0에만 존재
  assert.equal(gone.revision_id, "2025-01-01");
});

test("DELETED: 삭제 조문은 현행으로 인용하지 않음", async () => {
  const r = await t.get_clause({ law: LAW, clause: "제15조제2항", as_of: "2026-12-15" }, user);
  assert.equal(r.search_status, "DELETED");
  assert.equal(r.deletion_date, "2026-12-01");
});

test("NOT_FOUND_VERIFIED vs UNVERIFIED 구분", async () => {
  assert.equal((await t.get_clause({ law: LAW, clause: "제99조", as_of: "2026-12-15" }, user)).search_status, "NOT_FOUND_VERIFIED");
  assert.equal((await t.get_clause({ law: "가상 미등록법", clause: "제1조" }, user)).search_status, "UNVERIFIED");
  // 파싱 이슈가 있는 법령(L-001)은 부재를 확정하지 않는다
  assert.equal((await t.get_clause({ law: "가상여신거래법", clause: "제99조", as_of: "2026-12-15" }, user)).search_status, "UNVERIFIED");
});

test("verify_version·get_official_policy·compare_versions·resolve_reference", async () => {
  const v = await t.verify_version({ law: "SYN-LOAN-001", revision_id: "2026-11-01", as_of: "2026-12-15" }, user);
  assert.deepEqual([v.registered, v.official, v.current_as_of, v.superseded_by], [true, true, false, "2026-12-01"]);
  assert.equal((await t.verify_version({ law: "SYN-LOAN-001", revision_id: "2027-01-01" }, user)).registered, false);
  const pol = await t.get_official_policy({ law: "HB-REG-LOAN-001", as_of: "2026-11-15" }, user);
  assert.equal(pol.current?.revision_id, "2026-11-01");
  const cmp = await t.compare_versions({ law: LAW, old_revision: "2026-11-01", new_revision: "2026-12-01" }, user);
  assert.ok(cmp.changes.some((c) => c.path === "ARTICLE:12/PARAGRAPH:1" && c.kind === "MODIFIED"));
  const ref = await t.resolve_reference({ provision_id: "SYN-LOAN-001@2026-11-01/ARTICLE:12/PARAGRAPH:2" }, user);
  assert.equal(ref.references[0]!.target_id, "SYN-LOAN-001@2026-11-01/ARTICLE:12/PARAGRAPH:1");
  assert.equal(ref.references[0]!.exception_candidate, true);
});

test("Gateway 핸들러: 신원은 컨텍스트에서만, 인자 속 신원 무시", async () => {
  const h = makeHandler(t as never);
  const ctx = { clientContext: { custom: { bedrockAgentCoreToolName: "regulation___get_clause" } } };
  // __actor 없이 다른 이름의 신원 인자만 있으면 거부
  const denied = await h({ law: LAW, clause: "제12조", actor: user, user_id: "u1", groups: ["REG_APPROVER"] }, ctx);
  assert.equal((denied as { error: { code: string } }).error.code, "ACCESS_DENIED");
  const ok = await h({ law: LAW, clause: "제12조", as_of: "2026-12-15", __actor: user }, ctx);
  assert.equal((ok as { search_status: string }).search_status, "FOUND");
});

test("UNVERIFIED 버전·권한 밖 버전이 있으면 부재 확정 금지, 겹치는 기간은 최신 버전 우선, 부칙은 최신 부칙", async () => {
  const { MemoryClauseStore } = await import("./store.ts");
  const { parseLaw } = await import("@hanaeum/legal-parser");
  const s = new MemoryClauseStore();
  const law = (rev: string, txt: string) => parseLaw(txt, { law_id: "SYN-T-001", law_name: "가상시험규정", revision_id: rev });
  const rec = (rev: string, from: number, to: number, o: object = {}) => ({ law_id: "SYN-T-001", law_name: "가상시험규정", revision_id: rev, effective_from: from, effective_to: to, authority_status: "VERIFIED" as const, doc_id: rev, content_hash: "", acl_groups: ["ALL"], parse_ok: true, ...o });
  s.put(rec("2026-01-01", 20260101, 99991231), law("2026-01-01", "제1조(목적) 옛 기준 5억원.\n부칙\n제1조(시행일) 2026년 1월 1일 시행.\n부칙 <2026. 6. 1.>\n제1조(시행일) 2026년 6월 1일 시행."));
  s.put(rec("2026-07-01", 20260701, 99991231), law("2026-07-01", "제1조(목적) 새 기준 3억원."));
  s.put(rec("2027-01-01", 20270101, 99991231, { authority_status: "UNVERIFIED" }));
  const t = regulationTools(s, { today: () => 20261216 });
  assert.match((await t.get_clause({ law: "가상시험규정", clause: "제1조", as_of: "2026-12-15" }, user)).original_text!, /3억원/u);
  assert.equal((await t.get_clause({ law: "가상시험규정", clause: "제1조", as_of: "2025-01-01" }, user)).search_status, "UNVERIFIED");
  assert.match((await t.get_clause({ law: "가상시험규정", clause: "부칙 제1조", as_of: "2026-03-01" }, user)).original_text!, /6월 1일/u);
});

test("tools.json(Gateway 등록 스키마)과 구현 Tool 이름 일치 — regulation·search·graph", async () => {
  const { readFileSync } = await import("node:fs");
  const names = (p: string) => (JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")) as { name: string }[]).map((x) => x.name).sort();
  const { searchTools } = await import("@hanaeum/search-server");
  const { graphTools } = await import("@hanaeum/graph-server");
  assert.deepEqual(names("../tools.json"), Object.keys(t).sort());
  assert.deepEqual(names("../../search-server/tools.json"), Object.keys(searchTools({} as never)).sort());
  assert.deepEqual(names("../../graph-server/tools.json"), Object.keys(graphTools({} as never)).sort());
});

test("버전 박힌 조문 ID 조회 (dhxorb96 1924-1): K-003의 2025 인용 → HISTORICAL + 같은 위치 현행 조문", async () => {
  const r = await t.get_clause({ clause: "SYN-LOAN-001@2025-01-01/ARTICLE:12/PARAGRAPH:1", as_of: "2026-12-15" }, user);
  assert.equal(r.search_status, "HISTORICAL");
  assert.match(r.original_text!, /7억원/u);
  assert.equal(r.current!.revision_id, "2026-12-01");
  assert.equal(r.current!.status, "ACTIVE");
  assert.match(r.current!.original_text, /3억원/u);
  // 현행 버전을 인용하면 FOUND, current 없음
  const now = await t.get_clause({ clause: "SYN-LOAN-001@2026-12-01/ARTICLE:12/PARAGRAPH:1", as_of: "2026-12-15" }, user);
  assert.equal(now.search_status, "FOUND");
  assert.equal(now.current, undefined);
  // 개정으로 삭제된 위치: 현행 쪽 상태가 DELETED
  const del = await t.get_clause({ clause: "SYN-LOAN-001@2026-11-01/ARTICLE:15/PARAGRAPH:2", as_of: "2026-12-15" }, user);
  assert.equal(del.current!.status, "DELETED");
  // 현행에서 사라진 조문 (v0 제16조)
  const gone = await t.get_clause({ clause: "SYN-LOAN-001@2025-01-01/ARTICLE:16", as_of: "2026-12-15" }, user);
  assert.equal(gone.current!.status, "NOT_FOUND");
  assert.equal((await t.get_clause({ clause: "SYN-LOAN-001@2030-01-01/ARTICLE:1" }, user)).search_status, "UNVERIFIED");
});
