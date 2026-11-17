import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryClauseStore } from "@hanaeum/regulation-server";
import { fixtureClauseStore } from "../../regulation-server/src/fixtures.ts";
import { MemoryGraphStore, graphUpsertStep, graphTools, extractCitations, upsertStatements, lawGraph, BATCH } from "./index.ts";
import { parseLaw } from "@hanaeum/legal-parser";

const FIX = new URL("../../../tests/fixtures/", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, FIX), "utf8");
const manifest = JSON.parse(read("documents/manifest.json")) as { documents: { document_id: string; expected_impacted?: string[] }[] };
const frontCites = (p: string) => (read(p).match(/^cites: \[(.*)\]$/mu)![1]!).split(",").map((s) => s.trim()).filter(Boolean);
const base = { workflow_id: "wf_x", bucket: "q", prefix: "", actor: { sub: "s", groups: ["REG_APPROVER"] }, acl_groups: ["ALL"], content_hash: "sha256:x", authority_status: "VERIFIED" as const };
const LAW = { law_id: "SYN-LOAN-001", law_name: "하나은행 기업여신 심사규정" };

/** 3개 버전 규정 + K-001~K-003 노하우를 GraphUpsert 단계로 적재 */
async function loaded() {
  const graph = new MemoryGraphStore();
  const clauses = new MemoryClauseStore();
  const putLaw = async (r: Parameters<MemoryClauseStore["put"]>[0], l: Parameters<MemoryClauseStore["put"]>[1]) => clauses.put(r, l);
  const vers = [["F-000", "2025-01-01", 20250101, 20261031, undefined], ["F-001", "2026-11-01", 20261101, 20261130, "2025-01-01"], ["F-002", "2026-12-01", 20261201, 99991231, "2026-11-01"]] as const;
  for (const [doc, rev, from, to, prev] of vers) {
    const out = await graphUpsertStep({ ...base, doc_id: doc, version: 1, document_type: "REGULATION", title: LAW.law_name, effective_from: from, effective_to: to,
      content: read(`documents/${doc}.txt`), law: { ...LAW, revision_id: rev, previous_revision_id: prev } }, graph, Object.assign(clauses, { putLaw }));
    assert.equal(out.status, "OK", doc);
  }
  for (const k of ["K-001", "K-002", "K-003"]) {
    const citations = frontCites(`documents/${k}.md`).map((provision_id) => ({ provision_id, evidence_span: "front matter", confidence: 1 }));
    const out = await graphUpsertStep({ ...base, doc_id: k, version: 1, document_type: "KNOWHOW", title: k, effective_from: 20261101, effective_to: 99991231, content: read(`documents/${k}.md`), citations }, graph, clauses);
    assert.equal(out.status, "OK", k);
  }
  return { graph, clauses };
}

test("openCypher 배치: UNWIND MERGE, 배치 50, 레이블 명시", () => {
  const law = parseLaw(read("legal/source/L-001.txt"), { law_id: "SYN-VLOAN-001", law_name: "가상여신거래법", revision_id: "2026-11-01" });
  const st = upsertStatements(lawGraph(law, { doc_id: "L-001", effective_from: 20261101, effective_to: 99991231 }));
  assert.ok(st.every((s) => s.parameters.items.length <= BATCH));
  assert.ok(st.some((s) => s.query.startsWith("UNWIND $items AS i MERGE (n:CLAUSE_VERSION {id: i.id})")));
  assert.ok(st.some((s) => /MATCH \(a:CLAUSE_VERSION \{id: i\.from\}\) MATCH \(b:CLAUSE_VERSION \{id: i\.to\}\) MERGE \(a\)-\[r:REFERENCES\]->\(b\)/u.test(s.query)));
  const all = st.flatMap((s) => s.parameters.items as { props: { doc_id: string } }[]);
  assert.ok(all.every((i) => i.props.doc_id === "L-001"), "모든 노드·엣지에 doc_id");
});

test("멱등: 같은 문서를 두 번 적재해도 그래프 동일, 문서 단위 삭제", async () => {
  const { graph, clauses } = await loaded();
  const [n, e] = [graph.nodes.size, graph.edges.size];
  await graphUpsertStep({ ...base, doc_id: "K-001", version: 1, document_type: "KNOWHOW", title: "K-001", effective_from: 20261101, effective_to: 99991231, content: "", citations: frontCites("documents/K-001.md").map((provision_id) => ({ provision_id, evidence_span: "front matter", confidence: 1 })) }, graph, clauses);
  assert.deepEqual([graph.nodes.size, graph.edges.size], [n, e]);
  await graph.deleteDoc("K-001");
  assert.ok(![...graph.nodes.values()].some((x) => x.props["doc_id"] === "K-001"));
  assert.ok(![...graph.edges.values()].some((x) => x.props.doc_id === "K-001"));
});

test("Change Impact F-001→F-002: 정답 영향 문서와 일치, 근거·수치 변화 포함", async () => {
  const { graph, clauses } = await loaded();
  const t = graphTools({ graph, clauses });
  const r = await t.trace_impact({ law: LAW.law_name, old_revision: "2026-11-01", new_revision: "2026-12-01" }, { sub: "a", groups: ["REG_APPROVER"] });
  const expected = manifest.documents.find((d) => d.document_id === "F-002")!.expected_impacted!;
  assert.deepEqual(r.impacted.map((i) => i.doc_id), expected);
  const k1 = r.impacted.find((i) => i.doc_id === "K-001")!;
  assert.equal(k1.relation, "DIRECT");
  assert.equal(k1.risk, "HIGH");
  assert.ok(k1.evidence.some((e) => e.change.path === "ARTICLE:12/PARAGRAPH:1" && e.change.numbers_changed.new[0] === "3억원"));
  await assert.rejects(t.trace_impact({ law: LAW.law_name }, { sub: "u", groups: ["USER"] }), /AUTHOR·REG_APPROVER/u);
});

test("삭제(DELETED)된 노하우는 그래프에 남아 있어도 trace_impact에서 제외 (Documents 재검증)", async () => {
  const { graph, clauses } = await loaded();
  const args = { law: LAW.law_name, old_revision: "2026-11-01", new_revision: "2026-12-01" };
  const r = await graphTools({ graph, clauses, live: async (id) => id !== "K-001" }).trace_impact(args, { sub: "a", groups: ["AUTHOR"] });
  assert.ok(!r.impacted.some((i) => i.doc_id === "K-001"));
  assert.ok(r.impacted.length > 0);
});

test("간접 영향: 변경 조문을 참조하는 조문을 인용한 노하우도 탐지 (1홉)", async () => {
  const { graph, clauses } = await loaded();
  // 제12조제2항("제1항에도 불구하고")만 인용한 노하우 → 제12조제1항 변경의 간접 영향
  await graphUpsertStep({ ...base, doc_id: "K-900", version: 1, document_type: "KNOWHOW", title: "예금담보 전결 팁", effective_from: 20261101, effective_to: 99991231, content: "",
    citations: [{ provision_id: "SYN-LOAN-001@2026-11-01/ARTICLE:12/PARAGRAPH:2", evidence_span: "예금담보대출은 영업점장 전결", confidence: 1 }] }, graph, clauses);
  const r = await graphTools({ graph, clauses }).trace_impact({ law: "SYN-LOAN-001", old_revision: "2026-11-01", new_revision: "2026-12-01" }, { sub: "a", groups: ["AUTHOR"] });
  const k = r.impacted.find((i) => i.doc_id === "K-900")!;
  assert.equal(k.relation, "INDIRECT");
  assert.match(k.evidence[0]!.via_provision!, /ARTICLE:12\/PARAGRAPH:2 → ARTICLE:12\/PARAGRAPH:1/u);
});

test("없는 조문 인용은 그래프에 올리지 않고 Finding", async () => {
  const { graph, clauses } = await loaded();
  const out = await graphUpsertStep({ ...base, doc_id: "K-901", version: 1, document_type: "KNOWHOW", title: "x", effective_from: 20261101, effective_to: 99991231, content: "",
    citations: [{ provision_id: "SYN-LOAN-001@2026-11-01/ARTICLE:99", evidence_span: "", confidence: 1 }] }, graph, clauses);
  assert.equal(out.status, "REVIEW_REQUIRED");
  assert.equal(out.findings![0]!.code, "CITATION_TARGET_MISSING");
});

test("인용 후보 추출: K-001·K-003 본문에서 front matter 정답 복원", async () => {
  const store = fixtureClauseStore();
  for (const k of ["K-001", "K-003"]) {
    const got = (await extractCitations(read(`documents/${k}.md`), store, 20261115)).map((c) => c.provision_id).sort();
    assert.deepEqual(got, frontCites(`documents/${k}.md`).sort(), k);
  }
  assert.deepEqual(await extractCitations(read("documents/K-004.md"), store, 20261115), []);
});

test("ACL: 다른 부서 전용 노하우는 trace_impact·get_dependencies에 노출되지 않음", async () => {
  const { graph, clauses } = await loaded();
  await graphUpsertStep({ ...base, acl_groups: ["DEPT#리스크"], doc_id: "K-902", version: 1, document_type: "KNOWHOW", title: "리스크부 전용", effective_from: 20261101, effective_to: 99991231, content: "",
    citations: [{ provision_id: "SYN-LOAN-001@2026-11-01/ARTICLE:12/PARAGRAPH:1", evidence_span: "비공개 근거", confidence: 1 }] }, graph, clauses);
  const t = graphTools({ graph, clauses });
  const args = { law: "SYN-LOAN-001", old_revision: "2026-11-01", new_revision: "2026-12-01" };
  assert.ok(!(await t.trace_impact(args, { sub: "a", groups: ["AUTHOR"], dept: "여신" })).impacted.some((i) => i.doc_id === "K-902"));
  assert.ok((await t.trace_impact(args, { sub: "b", groups: ["AUTHOR"], dept: "리스크" })).impacted.some((i) => i.doc_id === "K-902"));
  await assert.rejects(t.get_dependencies({ id: "K-902@v1" }, { sub: "a", groups: ["AUTHOR"], dept: "여신" }), /권한/u);
});

test("새 버전 적재 시 겹치는 이전 버전 종료일을 닫아 현행으로 남지 않게 함, 파싱 이슈는 미적재", async () => {
  const graph = new MemoryGraphStore();
  const clauses = new MemoryClauseStore();
  const w = Object.assign(clauses, { putLaw: async (r: Parameters<MemoryClauseStore["put"]>[0], l: Parameters<MemoryClauseStore["put"]>[1]) => clauses.put(r, l) });
  const reg = (doc: string, rev: string, from: number) => graphUpsertStep({ ...base, doc_id: doc, version: 1, document_type: "REGULATION", title: LAW.law_name, effective_from: from, effective_to: 99991231,
    content: read(`documents/${doc}.txt`), law: { ...LAW, revision_id: rev } }, graph, w);
  await reg("F-001", "2026-11-01", 20261101);
  await reg("F-002", "2026-12-01", 20261201);
  assert.equal((await clauses.revisions("SYN-LOAN-001")).find((r) => r.revision_id === "2026-11-01")!.effective_to, 20261130);
  const bad = await graphUpsertStep({ ...base, doc_id: "L-001", version: 1, document_type: "REGULATION", title: "가상여신거래법", effective_from: 20261101, effective_to: 99991231,
    content: read("legal/source/L-001.txt"), law: { law_id: "SYN-VLOAN-001", law_name: "가상여신거래법", revision_id: "2026-11-01" } }, graph, w);
  assert.equal(bad.status, "REVIEW_REQUIRED");
  assert.equal((await clauses.revisions("SYN-VLOAN-001")).length, 0, "검토 전 미적재");
});

test("단계 13 입력 구성: 공통 입력만으로 Documents·게시본을 읽고, 인용이 없으면 본문에서 확인된 조문만 추출", async () => {
  const { MemoryObjectStore, MemoryRecords } = await import("@hanaeum/legal-etl");
  const { buildUpsertInput } = await import("./index.ts");
  const s = new MemoryObjectStore(); const r = new MemoryRecords();
  r.documents.set("K-001", { doc_id: "K-001", version: 1, title: "부동산 담보평가 실무 노하우", document_type: "KNOWHOW", authority_status: "VERIFIED", dept: "여신", acl_groups: ["ALL"], effective_from: 20261115 });
  await s.put("pub", "knowledge/K-001/content.txt", read("documents/K-001.md"));
  const inp = await buildUpsertInput({ workflow_id: "wf_x", doc_id: "K-001", version: 1, bucket: "q", prefix: "", actor: { sub: "s", groups: [] } }, r, s, fixtureClauseStore(), "pub");
  assert.deepEqual(inp.citations!.map((c) => c.provision_id).sort(), frontCites("documents/K-001.md").sort());
  assert.equal(inp.document_type, "KNOWHOW");
});
