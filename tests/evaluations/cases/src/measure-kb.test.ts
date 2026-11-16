// 실환경 측정 스크립트의 검출 로직을 메모리 KB로 먼저 검증 (실 KB 측정 결과를 믿을 수 있게)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chunkKnowledge } from "@hanaeum/kb-chunker";
import { buildEnv } from "./measure.ts";
import { measureLive, measureVisibility, measureUnverified, fingerprints } from "./measure-kb.ts";

test("고유 문장 추출: 차단 대상 텍스트 문서 전부(20건)에 게시 대상과 겹치지 않는 문장이 있음", () => {
  const m = JSON.parse(readFileSync(new URL("../../../fixtures/golden/manifest.json", import.meta.url), "utf8")) as { documents: { document_id: string; file: string; expected_kb_visibility: unknown }[] };
  const blocked = m.documents.filter((d) => d.expected_kb_visibility === false && !d.file.endsWith(".png")).map((d) => d.document_id).sort();
  const fps = fingerprints();
  assert.deepEqual(fps.map((f) => f.id).sort(), blocked);
  assert.equal(blocked.length, 20);
  assert.ok(fps.find((f) => f.id === "F-003")!.lines.some((l) => l.includes("10억원")));
});

test("정상 색인 상태(게시 대상만)에서 노출 0건, 조문 20/20, 삭제 오인용 0", async () => {
  const env = buildEnv();
  const r = await measureLive({ raw: env.retriever, search: env.search });
  assert.deepEqual(r.visibility.visible, []);
  assert.equal(r.clause.correct, 20, r.clause.fails.join("; "));
  assert.equal(r.deletionMis, 0);
  assert.equal(r.cite.forbidden.length, 0);
});

test("검출기 자체 검증: 차단 문서(F-003·A-001)가 색인에 섞이면 노출로 잡아냄", async () => {
  const env = buildEnv();
  for (const [id, file] of [["F-003", "documents/F-003.txt"], ["A-001", "documents/A-001.md"]] as const) {
    const text = readFileSync(new URL(`../../../fixtures/${file}`, import.meta.url), "utf8");
    for (const c of chunkKnowledge(text, { doc_id: id, title: id, document_type: "KNOWHOW", index_group: "wiki-knowledge", authority_status: "VERIFIED", freshness: "CURRENT", lifecycle: "PUBLISHED", effective_from: 20261101, effective_to: 99991231, acl_groups: ["ALL"], dept: "x", approval_id: "x", content_hash: "sha256:" + "0".repeat(64) })) env.retriever.add(c.augmented_search_text, c.metadata);
  }
  const r = await measureVisibility(env.retriever);
  assert.deepEqual(r.visible.sort(), ["A-001", "F-003"]);
});

test("검색 실패 판정: 조문 미확인·버전 미보유·미등록 법령은 UNVERIFIED (부재 단정·다른 조문 FOUND 0건)", async () => {
  const env = buildEnv();
  const r = await measureUnverified(env.search, false); // 관련도 판정 케이스(실제 Rerank 필요)는 실환경에서
  assert.deepEqual([r.ok, r.total, r.asserted, r.spurious], [3, 3, [], []]);
});
