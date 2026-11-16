// 데이터 QA 오프라인 측정 (docs/02 4장 중 let522mj 담당분, docs/05 5장)
// KB는 로컬 에뮬레이터(필터 그대로 평가 + bigram 점수)라 검색 "품질"이 아니라 파싱·필터·상태 판정 로직을 검증한다.
// 실제 KB 측정(가시성 0건, Rerank 품질)은 AWS 배포 후 같은 케이스로 다시 돌린다.
// 실행: node tests/evaluations/cases/src/measure.ts
import { readFileSync } from "node:fs";
import { parseLaw } from "@hanaeum/legal-parser";
import { chunkDocument } from "@hanaeum/kb-chunker";
import { regulationTools } from "@hanaeum/regulation-server";
import type { MemoryClauseStore } from "@hanaeum/regulation-server";
import { MemoryRetriever, MemoryDocStates, searchTools } from "@hanaeum/search-server";
import { MemoryGraphStore, graphUpsertStep, analyzeImpact, loadLaw } from "@hanaeum/graph-server";
import type { DocumentMetadata } from "@hanaeum/schemas";
import { fixtureClauseStore } from "../../../../mcp/regulation-server/src/fixtures.ts";

const FIX = new URL("../../../fixtures/", import.meta.url);
const CASES = new URL("../", import.meta.url);
const read = (u: URL) => readFileSync(u, "utf8");
const jsonl = <T>(f: string) => read(new URL(f, CASES)).split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);

/** 평가 기준일. HISTORICAL 판정이 실제 날짜에 흔들리지 않도록 고정 */
export const EVAL_TODAY = 20261216;
const USER = { sub: "eval-user", groups: ["USER"], dept: "여신" };
const APPROVER = { sub: "eval-approver", groups: ["REG_APPROVER"] };

interface Doc { document_id: string; category: string; file: string; document_type: "REGULATION" | "KNOWHOW" | "MANUAL"; law_id?: string; law_name?: string; revision_id?: string; dept: string; acl_groups: string[]; expected_kb_visibility: boolean | string; expected_structure?: [string, string][]; cites?: string[]; title?: string }
const golden = JSON.parse(read(new URL("golden/manifest.json", FIX))) as { documents: Doc[] };
const docs = golden.documents;
const frontCites = (text: string) => (text.match(/^cites: \[(.*)\]$/mu)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// ── 1. 법령 구조 파싱 정확도 ───────────────────────────
export function measureParsing() {
  const sets: { id: string; text: string; meta: { law_id: string; law_name: string; revision_id: string }; expected: [string, string][] }[] = [];
  const l001 = JSON.parse(read(new URL("legal/expected/L-001.json", FIX)));
  sets.push({ id: "L-001", text: read(new URL("legal/source/L-001.txt", FIX)), meta: l001.meta, expected: l001.provisions });
  for (const d of docs.filter((x) => x.expected_structure)) {
    sets.push({ id: d.document_id, text: read(new URL(d.file, FIX)), meta: { law_id: d.law_id!, law_name: d.law_name!, revision_id: d.revision_id! }, expected: d.expected_structure! });
  }
  let matched = 0, union = 0;
  const misses: string[] = [];
  for (const s of sets) {
    const law = parseLaw(s.text, s.meta);
    const B = `${s.meta.law_id}@${s.meta.revision_id}/`;
    const got = new Set(law.provisions.map((p) => `${p.provision_id.slice(B.length)}|${p.status}`));
    const exp = new Set(s.expected.map(([p, st]) => `${p}|${st}`));
    for (const e of exp) if (got.has(e)) matched++; else misses.push(`${s.id}: 누락 ${e}`);
    for (const g of got) if (!exp.has(g)) misses.push(`${s.id}: 초과 ${g}`);
    union += new Set([...exp, ...got]).size;
  }
  return { docs: sets.length, accuracy: matched / union, matched, union, misses };
}

// ── 공용: 검색 환경 (게시 대상 문서만 색인) ─────────────
function buildEnv() {
  const clauses = fixtureClauseStore() as MemoryClauseStore;
  const retriever = new MemoryRetriever();
  const states = new MemoryDocStates();
  for (const d of docs) {
    if (d.expected_kb_visibility !== true || d.file.endsWith(".png")) continue;
    const text = read(new URL(d.file, FIX));
    const rev = d.law_id ? clauses.revs.find((r) => r.law_id === d.law_id && r.revision_id === d.revision_id) : undefined;
    const hash = "sha256:" + "0".repeat(64);
    const meta: DocumentMetadata = {
      doc_id: d.document_id, title: d.law_name ?? (text.match(/^title: (.*)$/mu)?.[1] ?? d.document_id), law_name: d.law_name,
      document_type: d.document_type, index_group: d.document_type === "REGULATION" ? "legal-clauses" : "wiki-knowledge",
      authority_status: "VERIFIED", freshness: "CURRENT", lifecycle: "PUBLISHED", law_id: d.law_id, revision_id: d.revision_id,
      effective_from: rev?.effective_from ?? 20261101, effective_to: rev?.effective_to ?? 99991231,
      acl_groups: d.acl_groups, dept: d.dept, approval_id: "apr_eval", content_hash: hash,
    };
    if (d.document_type === "REGULATION" && !d.law_name) meta.law_name = rev?.law_name;
    for (const c of chunkDocument(text, meta)) retriever.add(c.augmented_search_text, c.metadata);
    states.docs.set(d.document_id, { doc_id: d.document_id, lifecycle: "PUBLISHED", authority_status: "VERIFIED", freshness: "CURRENT", acl_groups: d.acl_groups, published_content_hash: hash });
  }
  const regulation = regulationTools(clauses, { today: () => EVAL_TODAY });
  return { clauses, retriever, search: searchTools({ retriever, states, regulation }) };
}

// ── 2. 정확 조문 검색 20 + 3. 삭제 조항 오인용 ──────────
interface ClauseCase { id: string; query: string; as_of: string; expected_status: string; expected_provision_id?: string; expected_text?: string }
export async function measureClauseSearch() {
  const env = buildEnv();
  const rows: { id: string; ok: boolean; got: string; expected: string; via: string }[] = [];
  for (const c of jsonl<ClauseCase>("clause_lookup.jsonl")) {
    const r = await env.search.search_legal_clause({ query: c.query, as_of: c.as_of }, USER) as { via: string; search_status: string; provision_id?: string; original_text?: string };
    const ok = r.search_status === c.expected_status
      && (!c.expected_provision_id || r.provision_id === c.expected_provision_id)
      && (!c.expected_text || !!r.original_text?.includes(c.expected_text));
    rows.push({ id: c.id, ok, got: `${r.search_status} ${r.provision_id ?? ""}`, expected: `${c.expected_status} ${c.expected_provision_id ?? ""}`, via: r.via });
  }
  return { total: rows.length, correct: rows.filter((r) => r.ok).length, rows };
}

export async function measureDeletionSafety() {
  const env = buildEnv();
  // (a) 조문 조회: 삭제·과거 조문이 FOUND(현행)로 나오면 오인용
  const lookups = jsonl<ClauseCase>("clause_lookup.jsonl").filter((c) => ["DELETED", "HISTORICAL"].includes(c.expected_status));
  let lookupMis = 0;
  for (const c of lookups) {
    const r = await env.search.search_legal_clause({ query: c.query, as_of: c.as_of }, USER) as { search_status: string };
    if (r.search_status === "FOUND") lookupMis++;
  }
  // (b) 자유 질의: 삭제 조문의 옛 본문으로 검색했을 때 삭제 조문이 현행 근거로 반환되면 오인용
  let probes = 0, searchMis = 0;
  for (const r of env.clauses.revs) {
    if (r.effective_to < EVAL_TODAY) continue;
    for (const p of (await env.clauses.provisions(r.law_id, r.revision_id)) ?? []) {
      if (p.status !== "DELETED") continue;
      const prev = env.clauses.revs.filter((x) => x.law_id === r.law_id && x.effective_to < r.effective_from).at(-1);
      const oldText = prev && (await env.clauses.provisions(r.law_id, prev.revision_id))?.find((x) => x.provision_id.endsWith(p.provision_id.slice(p.provision_id.indexOf("/"))))?.normalized_text;
      const q = oldText || p.path_label;
      probes++;
      const res = await env.search.search_wiki({ query: q, as_of: "2026-12-15" }, USER);
      if (res.results.some((x) => x.provision_id === p.provision_id || x.provision_status === "DELETED")) searchMis++;
    }
  }
  return { lookup_cases: lookups.length, lookup_miscitations: lookupMis, search_probes: probes, search_miscitations: searchMis, miscitations: lookupMis + searchMis };
}

// ── 4. 변경 영향 탐지 ──────────────────────────────────
export async function measureImpact() {
  const clauses = fixtureClauseStore() as MemoryClauseStore;
  const graph = new MemoryGraphStore();
  const base = { workflow_id: "wf_eval", bucket: "-", prefix: "", actor: APPROVER, acl_groups: ["ALL"], content_hash: "-", authority_status: "VERIFIED" as const };
  // 규정 전 버전 그래프 적재 (구조는 저장소에 이미 있으므로 putLaw 생략)
  const byLaw = new Map<string, typeof clauses.revs>();
  for (const r of clauses.revs) byLaw.set(r.law_id, [...(byLaw.get(r.law_id) ?? []), r]);
  for (const [, revs] of byLaw) {
    revs.sort((a, b) => a.effective_from - b.effective_from);
    for (const [i, r] of revs.entries()) {
      const law = await loadLaw(clauses, r.law_id, r.revision_id);
      const { lawGraph } = await import("@hanaeum/graph-server");
      await graph.upsert(lawGraph(law, { doc_id: r.doc_id, effective_from: r.effective_from, effective_to: r.effective_to, previous_revision_id: revs[i - 1]?.revision_id }));
    }
  }
  // 승인된 노하우 인용 적재 (정답 manifest의 cites = 승인 시 확정된 인용)
  for (const d of docs.filter((x) => x.document_type === "KNOWHOW" && x.expected_kb_visibility !== false && !x.file.endsWith(".png"))) {
    const cites = d.cites ?? frontCites(read(new URL(d.file, FIX)));
    await graphUpsertStep({ ...base, doc_id: d.document_id, version: 1, document_type: "KNOWHOW", title: d.document_id, effective_from: 20261101, effective_to: 99991231, content: "",
      citations: cites.map((provision_id) => ({ provision_id, evidence_span: "manifest", confidence: 1 })) }, graph, clauses);
  }
  // K-003(과거 규정 인용)은 검토 대상이지만 그래프에는 승인 이력이 있는 것으로 보고 포함 (데모 04 시나리오)
  await graphUpsertStep({ ...base, doc_id: "K-003", version: 1, document_type: "KNOWHOW", title: "K-003", effective_from: 20250101, effective_to: 99991231, content: "",
    citations: frontCites(read(new URL("documents/K-003.md", FIX))).map((provision_id) => ({ provision_id, evidence_span: "front matter", confidence: 1 })) }, graph, clauses);

  const sets = JSON.parse(read(new URL("sets.json", CASES))) as { impact: { law_id: string; old_revision: string; new_revision: string; expected_impacted: string[]; expected_not_impacted?: string[] }[] };
  let expected = 0, detected = 0, falsePos = 0;
  const rows = [];
  for (const s of sets.impact) {
    const r = await analyzeImpact(await loadLaw(clauses, s.law_id, s.old_revision), await loadLaw(clauses, s.law_id, s.new_revision), graph);
    const got = r.impacted.map((i) => i.doc_id);
    expected += s.expected_impacted.length;
    detected += s.expected_impacted.filter((d) => got.includes(d)).length;
    falsePos += (s.expected_not_impacted ?? []).filter((d) => got.includes(d)).length;
    rows.push({ law: s.law_id, expected: s.expected_impacted, got });
  }
  return { expected, detected, false_positives: falsePos, rows };
}

// ── 실행 ───────────────────────────────────────────────
export async function measureAll() {
  const parsing = measureParsing();
  const clause = await measureClauseSearch();
  const deletion = await measureDeletionSafety();
  const impact = await measureImpact();
  return { parsing, clause, deletion, impact };
}

if (import.meta.main) {
  const r = await measureAll();
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(`| 항목 | 목표 | 오프라인 측정 (${EVAL_TODAY} 기준) | 판정 |`);
  console.log("|---|---|---|---|");
  console.log(`| 법령 구조 파싱 | 95% 이상 | ${pct(r.parsing.accuracy)} (${r.parsing.matched}/${r.parsing.union}, 법령 ${r.parsing.docs}건) | ${r.parsing.accuracy >= 0.95 ? "통과" : "미달"} |`);
  console.log(`| 정확 조문 검색 | 20건 중 19건 이상 | ${r.clause.correct}/${r.clause.total} | ${r.clause.correct >= 19 ? "통과" : "미달"} |`);
  console.log(`| 삭제 조항 오인용 | 0건 | ${r.deletion.miscitations}건 (조회 ${r.deletion.lookup_cases} + 자유질의 ${r.deletion.search_probes}) | ${r.deletion.miscitations === 0 ? "통과" : "미달"} |`);
  console.log(`| 변경 영향 탐지 | 지정 5건 모두 | ${r.impact.detected}/${r.impact.expected}, 오탐 ${r.impact.false_positives} | ${r.impact.detected === r.impact.expected && r.impact.expected === 5 ? "통과" : "미달"} |`);
  console.log(`| 승인 전 KB 가시성 | 0건 | AWS KB 배포 후 측정 | 미측정 |`);
  for (const row of r.clause.rows.filter((x) => !x.ok)) console.log(`  조문 검색 실패 ${row.id}: got ${row.got} / expected ${row.expected} (${row.via})`);
  for (const m of r.parsing.misses.slice(0, 20)) console.log(`  파싱 ${m}`);
}
