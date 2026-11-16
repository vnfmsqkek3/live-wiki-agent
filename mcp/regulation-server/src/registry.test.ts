import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixtureClauseStore } from "./fixtures.ts";
import { registryMatch } from "./registry.ts";

const FIX = new URL("../../../tests/fixtures/", import.meta.url);
const pdfHash = (id: string) => (JSON.parse(readFileSync(new URL("documents/pdf/hashes.json", FIX), "utf8")) as Record<string, string>)[id]!;
const text = (id: string) => readFileSync(new URL(`documents/${id}.txt`, FIX), "utf8");

test("Registry 대조: PDF 원본 해시 일치 → 해당 개정본 (TrustGate VERIFIED 근거)", async () => {
  const m = await registryMatch(fixtureClauseStore(), pdfHash("F-001"));
  assert.equal(m.registry?.law_id, "SYN-LOAN-001");
  assert.equal(m.registry?.revision_id, "2026-11-01");
  assert.equal(m.registry?.content_hash, pdfHash("F-001"));
  assert.equal(m.registry?.effective_from, "2026-11-01");
  assert.equal(m.claimed?.law_id, "SYN-LOAN-001");
  assert.ok(m.registry!.clauses["ARTICLE:12/PARAGRAPH:1"]?.includes("5억원"));
});

test("Registry 대조: 위조 F-003은 해시 불일치 → 머리말로 주장 개정본을 찾고 조문 차이가 드러남", async () => {
  const s = fixtureClauseStore();
  const m = await registryMatch(s, pdfHash("F-003"), text("F-003"));
  assert.equal(m.claimed?.revision_id, "2026-11-01");
  assert.notEqual(m.registry?.content_hash, pdfHash("F-003"));
  const diff = Object.keys({ ...m.registry!.clauses, ...m.claimed!.clauses! }).filter((k) => m.registry!.clauses[k] !== m.claimed!.clauses![k]);
  assert.ok(diff.length > 0, "위조 조문 차이 1개 이상");
  // 정상 F-001 본문으로 같은 경로를 타면 차이 0 (파싱 기준 일치)
  const ok = await registryMatch(s, "sha256:unknown", text("F-001"));
  assert.deepEqual(Object.keys(ok.registry!.clauses).filter((k) => ok.registry!.clauses[k] !== ok.claimed!.clauses![k]), []);
  // 법령명 없는 문서·텍스트 없음 → 미등록
  assert.deepEqual(await registryMatch(s, "sha256:unknown", "SYNTHETIC 노하우 메모"), {});
  assert.deepEqual(await registryMatch(s, "sha256:unknown"), {});
});
