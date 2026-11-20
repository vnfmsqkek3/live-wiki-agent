import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryClauseStore } from "@hanaeum/regulation-server";
import { fixtureClauseStore } from "../../regulation-server/src/fixtures.ts";
import { MemoryGraphStore, graphDeleteStep, graphUpsertStep, graphTools, extractCitations, upsertStatements, lawGraph, BATCH } from "./index.ts";
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

test("새 버전 적재 시 겹치는 이전 버전 종료일을 닫아 현행으로 남지 않게 함, 파싱 이슈가 있어도 승인된 게시라 '구조 미확정'으로 적재", async () => {
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
  // yoyo0704 11/19: 안 쓰면 KB에는 게시됐는데 조문 저장소·그래프에는 없는 규정이 생김 → parse_ok=false 로 적재, 부재·과거 단정은 조회에서 막음
  const [vl] = await clauses.revisions("SYN-VLOAN-001");
  assert.equal(vl?.parse_ok, false);
  assert.ok((await clauses.provisions("SYN-VLOAN-001", "2026-11-01"))?.length);
  assert.ok(bad.findings?.every((f) => !/구조 검토 완료/u.test(f.fix_hint ?? "")), "없는 기능 안내 금지");
  // 개정본에 파싱 이슈가 있으면 노하우 재검토 표시는 생략하고 알림 (못 읽은 조문이 '삭제'로 보이므로)
  const marked: string[] = [];
  const claims = { claimsCiting: async () => [{ claim_id: "C#1", provision_id: "SYN-LOAN-001@2026-12-01/ARTICLE:12" }], markClaimReview: async (id: string) => { marked.push(id); } };
  const partial = await graphUpsertStep({ ...base, doc_id: "F-00X", version: 1, document_type: "REGULATION", title: LAW.law_name, effective_from: 20270101, effective_to: 99991231,
    content: read("documents/F-002.txt").replace(/^(제12조.*)$/mu, "$1\n제3조(역행) 번호 오류"), law: { ...LAW, revision_id: "2027-01-01" } }, graph, w, claims);
  assert.equal(partial.status, "REVIEW_REQUIRED");
  assert.deepEqual(marked, []);
  assert.ok(partial.findings?.some((f) => f.code === "CLAIM_REVIEW_SKIPPED"));
  // 인용 이슈만 있으면("같은 법 제9조" 등) 구조는 멀쩡 → parse_ok=true, 재검토 표시는 실행 (PR #64 리뷰)
  const refOnly = await graphUpsertStep({ ...base, doc_id: "F-00Y", version: 1, document_type: "REGULATION", title: LAW.law_name, effective_from: 20270201, effective_to: 99991231,
    content: read("documents/F-002.txt").replace(/^(제12조[^\n]*)$/mu, "$1 제99조에 따른다."), law: { ...LAW, revision_id: "2027-02-01" } }, graph, w, claims);
  assert.ok(refOnly.findings?.some((f) => f.code === "UNRESOLVED_REF"));
  assert.ok(!refOnly.findings?.some((f) => f.code === "CLAIM_REVIEW_SKIPPED"));
  assert.equal((await clauses.revisions("SYN-LOAN-001")).find((r) => r.revision_id === "2027-02-01")?.parse_ok, true);
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

test("단계 13 입력: 시행일 없는 노하우는 게시일 기준으로 인용 해석 (미래 개정본 F-002@2026-12-01이 Registry에 있어도 현행 조문, prod 11/20)", async () => {
  const { MemoryObjectStore, MemoryRecords } = await import("@hanaeum/legal-etl");
  const { buildUpsertInput } = await import("./index.ts");
  const s = new MemoryObjectStore(); const r = new MemoryRecords();
  r.documents.set("K-001", { doc_id: "K-001", version: 1, title: "부동산 담보평가 실무 노하우", document_type: "KNOWHOW", authority_status: "UNVERIFIED", dept: "여신", acl_groups: ["ALL"], published_at: "2026-11-20T04:00:00Z" } as never);
  await s.put("pub", "knowledge/K-001/content.txt", read("documents/K-001.md"));
  const inp = await buildUpsertInput({ workflow_id: "wf_x", doc_id: "K-001", version: 1, bucket: "q", prefix: "", actor: { sub: "s", groups: [] } }, r, s, fixtureClauseStore(), "pub");
  assert.deepEqual(inp.citations!.map((c) => c.provision_id).sort(), frontCites("documents/K-001.md").sort());
});

test("삭제 흐름(interfaces 6.0): DELETED만 그래프에서 지움, 아니면 NotDeleted, 분류 전 문서는 할 일 없이 OK", async () => {
  const { graph } = await loaded();
  const has = () => [...graph.nodes.values()].some((x) => x.props["doc_id"] === "K-001");
  const rec = (d: unknown) => ({ getDocument: async () => d as never });
  await assert.rejects(graphDeleteStep("K-001", rec({ lifecycle: "PUBLISHED" }), graph), { name: "NotDeleted" });
  await assert.rejects(graphDeleteStep("K-001", rec(undefined), graph), { name: "NotDeleted" });
  assert.ok(has());
  assert.deepEqual(await graphDeleteStep("K-001", rec({ lifecycle: "DELETED" }), graph), { status: "OK", affected_doc_ids: [] });
  assert.ok(!has());
  const unclassified = { getDocument: async () => { throw Object.assign(new Error("x"), { name: "UnclassifiedDocument" }); } };
  assert.deepEqual(await graphDeleteStep("K-404", unclassified, graph), { status: "OK", affected_doc_ids: [] });
});

test("규정 삭제: 그 조문을 인용하던 노하우를 재검토 대상으로 돌려주고, 공유 LAW 노드는 남은 개정본이 있으면 유지", async () => {
  const { graph } = await loaded();
  const regDoc = (rev: string) => String([...graph.nodes.values()].find((n) => n.label === "LAW_VERSION" && n.props["revision_id"] === rev)!.props["doc_id"]);
  const cited = regDoc("2026-11-01");
  const affected = await graph.deleteDoc(cited);
  assert.ok(affected.includes("K-001"), "K-001은 2026-11-01 조문을 인용");
  assert.ok(![...graph.nodes.values()].some((n) => n.props["doc_id"] === cited && n.label !== "LAW"));
  const others = [...graph.nodes.values()].filter((n) => n.label === "LAW_VERSION").map((n) => String(n.props["doc_id"]));
  assert.ok(graph.nodes.has("SYN-LOAN-001") === others.length > 0, "남은 개정본이 있으면 LAW 유지");
  for (const d of others) await graph.deleteDoc(d);
  assert.ok(!graph.nodes.has("SYN-LOAN-001"), "개정본이 모두 지워지면 LAW도 삭제");
});

test("규정 게시가 Trusted Registry 원본 해시를 덮어쓰지 않음 (11/17 재업로드 실측: 같은 공식 원본이 '출처 불일치'로 막힘)", async () => {
  const graph = new MemoryGraphStore();
  const clauses = new MemoryClauseStore();
  const law0 = { law_id: LAW.law_id, law_name: LAW.law_name, revision_id: "2026-11-01" };
  // Registry 적재분: 원본 텍스트 해시 + PDF 해시
  clauses.put({ ...law0, effective_from: 20261101, effective_to: 99991231, authority_status: "VERIFIED", doc_id: "F-001", content_hash: "sha256:registry-text", pdf_content_hash: "sha256:registry-pdf", acl_groups: ["ALL"], parse_ok: true },
    { ...law0, effective_from: 20261101, parser_version: "", provisions: [], issues: [] });
  const putLaw = async (r: Parameters<MemoryClauseStore["put"]>[0], l: Parameters<MemoryClauseStore["put"]>[1]) => clauses.put(r, l);
  const out = await graphUpsertStep({ ...base, doc_id: "doc_pub", version: 1, document_type: "REGULATION", title: LAW.law_name, effective_from: 20261101, effective_to: 99991231,
    content: read("documents/F-001.txt"), content_hash: "sha256:published-content", law: { ...LAW, revision_id: "2026-11-01" } }, graph, Object.assign(clauses, { putLaw }));
  assert.equal(out.status, "OK");
  assert.equal((await clauses.revisionByHash("sha256:registry-pdf"))?.revision_id, "2026-11-01", "같은 PDF를 다시 올려도 Registry와 일치");
  const r = (await clauses.revisions(LAW.law_id)).find((x) => x.revision_id === "2026-11-01")!;
  assert.equal(r.content_hash, "sha256:registry-text");
  assert.equal(r.doc_id, "doc_pub", "게시 문서 연결은 갱신");
});

test("개정 시 바뀐 조문에 근거를 둔 주장만 REVIEW_REQUIRED (interfaces 10.2, 사용자 결정 11/17 얇은 주장 단위)", async () => {
  const graph = new MemoryGraphStore();
  const clauses = new MemoryClauseStore();
  const putLaw = async (r: Parameters<MemoryClauseStore["put"]>[0], l: Parameters<MemoryClauseStore["put"]>[1]) => clauses.put(r, l);
  const store = Object.assign(clauses, { putLaw });
  // F-001(11/1) 주장 3개: 바뀐 제10조②·제12조①, 안 바뀐 제11조
  const old = "SYN-LOAN-001@2026-11-01";
  const claimRows = [
    { claim_id: "K-001#1", provision_id: `${old}/ARTICLE:10/PARAGRAPH:2` },
    { claim_id: "K-003#1", provision_id: `${old}/ARTICLE:12` },
    { claim_id: "K-003#2", provision_id: `${old}/ARTICLE:11` },
  ];
  const marked: [string, string][] = [];
  const claims = { claimsCiting: async (p: string) => claimRows.filter((c) => c.provision_id.startsWith(p)), markClaimReview: async (id: string, r: string) => { marked.push([id, r]); } };
  const vers = [["F-001", "2026-11-01", 20261101, 20261130, undefined], ["F-002", "2026-12-01", 20261201, 99991231, "2026-11-01"]] as const;
  for (const [doc, rev, from, to, prev] of vers) {
    const out = await graphUpsertStep({ ...base, doc_id: doc, version: 1, document_type: "REGULATION", title: LAW.law_name, effective_from: from, effective_to: to,
      content: read(`documents/${doc}.txt`), law: { ...LAW, revision_id: rev, previous_revision_id: prev } }, graph, store, claims);
    assert.equal(out.status, "OK", doc);
  }
  assert.deepEqual(marked.sort(), [
    ["K-001#1", "provision_revised:SYN-LOAN-001@2026-12-01/ARTICLE:10/PARAGRAPH:2"],
    ["K-003#1", "provision_revised:SYN-LOAN-001@2026-12-01/ARTICLE:12/PARAGRAPH:1"],
  ]);
});

test("주장 재검토 (PR #36 리뷰): 더 오래된 버전 인용도 직접 비교, 공백·문장부호 차이는 무시, 대량 변경이면 보류, 주장 테이블 없으면 게시 계속", async () => {
  const graph = new MemoryGraphStore();
  const clauses = new MemoryClauseStore();
  const putLaw = async (r: Parameters<MemoryClauseStore["put"]>[0], l: Parameters<MemoryClauseStore["put"]>[1]) => clauses.put(r, l);
  const store = Object.assign(clauses, { putLaw });
  const rows = [{ claim_id: "OLD#1", provision_id: "SYN-LOAN-001@2025-01-01/ARTICLE:12" }, { claim_id: "OLD#2", provision_id: "SYN-LOAN-001@2025-01-01/ARTICLE:1" }];
  const marked: string[] = [];
  const claims = { claimsCiting: async (p: string) => rows.filter((c) => c.provision_id.startsWith(p)), markClaimReview: async (id: string) => { marked.push(id); } };
  const vers = [["F-000", "2025-01-01", 20250101, 20261031, undefined], ["F-001", "2026-11-01", 20261101, 20261130, "2025-01-01"], ["F-002", "2026-12-01", 20261201, 99991231, "2026-11-01"]] as const;
  for (const [doc, rev, from, to, prev] of vers) {
    await graphUpsertStep({ ...base, doc_id: doc, version: 1, document_type: "REGULATION", title: LAW.law_name, effective_from: from, effective_to: to,
      content: read(`documents/${doc}.txt`), law: { ...LAW, revision_id: rev, previous_revision_id: prev } }, graph, store, claims);
  }
  // 2025-01-01 판 제12조를 인용한 주장은 12/1 판에서 5억→3억으로 바뀌어 재검토 (중간 11/1 판을 거쳐도)
  assert.ok(marked.includes("OLD#1"));
  assert.ok(!marked.includes("OLD#2"));
  // 공백·문장부호만 다른 새 본문 → 표시 없음
  const sameish = read("documents/F-002.txt").replace(/\. /gu, ".  ").replace(/,/gu, " ,");
  const marked2: string[] = [];
  const claims2 = { claimsCiting: async () => [{ claim_id: "X#1", provision_id: "SYN-LOAN-001@2026-12-01/ARTICLE:12" }], markClaimReview: async (id: string) => { marked2.push(id); } };
  await graphUpsertStep({ ...base, doc_id: "F-002b", version: 1, document_type: "REGULATION", title: LAW.law_name, effective_from: 20270101, effective_to: 99991231,
    content: sameish, law: { ...LAW, revision_id: "2027-01-01", previous_revision_id: "2026-12-01" } }, graph, store, claims2);
  assert.deepEqual(marked2, []);
  // 대량 변경(본문 인식 이상 의심) → 표시 보류 + LOW 안내, 게시는 OK
  const garbled = read("documents/F-002.txt").split("\n").map((l) => (l.trim() && !/^부\s*칙/u.test(l) ? `${l} 인식오류` : l)).join("\n"); // 모든 조문 본문이 달라짐 (부칙 머리는 그대로: 깨지면 파싱 이슈가 돼 재검토 자체를 생략)
  const out = await graphUpsertStep({ ...base, doc_id: "F-002c", version: 1, document_type: "REGULATION", title: LAW.law_name, effective_from: 20270201, effective_to: 99991231,
    content: garbled, law: { ...LAW, revision_id: "2027-02-01", previous_revision_id: "2027-01-01" } }, graph, store, claims2);
  assert.equal(out.status, "OK");
  assert.ok(out.findings?.some((f) => f.code === "CLAIM_REVIEW_HELD"));
  // 주장 테이블 없음(스키마 배포 전) → 게시 계속
  const missing = { claimsCiting: async () => { throw new Error('relation "claims" does not exist'); }, markClaimReview: async () => {} };
  const out2 = await graphUpsertStep({ ...base, doc_id: "F-002d", version: 1, document_type: "REGULATION", title: LAW.law_name, effective_from: 20270301, effective_to: 99991231,
    content: read("documents/F-002.txt"), law: { ...LAW, revision_id: "2027-03-01", previous_revision_id: "2027-02-01" } }, graph, store, missing);
  assert.equal(out2.status, "OK");
});

test("인용 추출은 그림·AI 쪽 정리 줄(⟦그림 pN⟧)을 근거로 쓰지 않음 (PR #38 리뷰)", async () => {
  const store = fixtureClauseStore();
  const body = "하나은행 기업여신 심사규정 제12조제1항에 따라 승인을 받는다.";
  const ai = "⟦그림 p0⟧ 쪽 정리(AI, 그림 기준): 하나은행 기업여신 심사규정 제10조제2항 감정평가서";
  const cs = await extractCitations(`${body}\n${ai}`, store, 20261215);
  assert.ok(cs.some((c) => c.provision_id.endsWith("ARTICLE:12/PARAGRAPH:1")));
  assert.ok(!cs.some((c) => c.provision_id.endsWith("ARTICLE:10/PARAGRAPH:2")));
});

test("인용 후보 추출: 대괄호 규정명 '[하나은행 기업여신 심사규정] 제12조'도 인용, 긴 한글 줄도 빠름 (PR #47)", async () => {
  const store = fixtureClauseStore();
  const got = (await extractCitations("승인은 [하나은행 기업여신 심사규정] 제12조에 따른다.", store, 20261115)).map((c) => c.provision_id);
  assert.ok(got.some((id) => /ARTICLE:12$/u.test(id)), got.join());
  const t0 = Date.now(); await extractCitations("가 ".repeat(50000), store, 20261115); assert.ok(Date.now() - t0 < 1000, "선형에 가까운 시간");
});

test("규정 게시: Trusted Registry 원본 버전은 조문 원문을 게시본(OCR·그림 정리본)으로 덮어쓰지 않음 (prod 11/20 엔드유저 D01)", async () => {
  const graph = new MemoryGraphStore();
  const clauses = new MemoryClauseStore();
  const law0 = { law_id: LAW.law_id, law_name: LAW.law_name, revision_id: "2026-11-01" };
  const official = parseLaw(read("documents/F-001.txt"), { ...law0, effective_from: 20261101 });
  clauses.put({ ...law0, effective_from: 20261101, effective_to: 99991231, authority_status: "VERIFIED", doc_id: "F-001", content_hash: "sha256:registry-text", pdf_content_hash: "sha256:registry-pdf", acl_groups: ["ALL"], parse_ok: true }, official);
  // 게시본: OCR 띄어쓰기 손실 + 그림 정리본이 붙은 마스킹 본문
  const ocr = read("documents/F-001.txt").replace("사업자등록증 사본", "사업자등록증사본").replace("시행한다.", "시행한다. ⟦그림 p0⟧ 쪽 정리(AI, 그림 기준): 표지");
  const putLaw = async (r: Parameters<MemoryClauseStore["put"]>[0], l: Parameters<MemoryClauseStore["put"]>[1]) => clauses.put(r, l);
  await graphUpsertStep({ ...base, doc_id: "doc_pub", version: 1, document_type: "REGULATION", title: LAW.law_name, effective_from: 20261101, effective_to: 99991231,
    content: ocr, content_hash: "sha256:published-content", law: { ...LAW, revision_id: "2026-11-01" } }, graph, Object.assign(clauses, { putLaw }));
  const after = (await clauses.provisions(LAW.law_id, "2026-11-01"))!;
  assert.deepEqual(after.map((p) => p.normalized_text), official.provisions.map((p) => p.normalized_text), "Registry 원문 유지");
  assert.equal((await clauses.revisions(LAW.law_id)).find((x) => x.revision_id === "2026-11-01")!.doc_id, "doc_pub", "게시 문서 연결은 갱신");
});
