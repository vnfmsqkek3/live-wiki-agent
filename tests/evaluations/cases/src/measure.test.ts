// 데이터 QA 회귀 게이트 (docs/02 4장 기준치). 기준 미달이면 CI 실패
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { measureParsing, measureClauseSearch, measureDeletionSafety, measureImpact } from "./measure.ts";

const FIX = new URL("../../../fixtures/", import.meta.url);

test("Golden 60건 구성·SYNTHETIC 표시·Registry 해시", () => {
  const m = JSON.parse(readFileSync(new URL("golden/manifest.json", FIX), "utf8"));
  assert.equal(m.documents.length, 60);
  assert.deepEqual(m.counts, { "기반 규정": 15, "개정·삭제": 10, "악성·위조": 10, "정상 노하우": 15, "충돌 노하우": 10 });
  for (const d of m.documents) assert.ok(readFileSync(new URL(d.file, FIX)).includes("SYNTHETIC"), d.document_id);
  const reg = JSON.parse(readFileSync(new URL("registry/registry.golden.json", FIX), "utf8"));
  for (const r of reg.regulations) assert.equal("sha256:" + createHash("sha256").update(readFileSync(new URL(r.fixture, FIX))).digest("hex"), r.content_hash, r.fixture);
});

test("법령 구조 파싱 ≥ 95%", () => assert.ok(measureParsing().accuracy >= 0.95));
test("정확 조문 검색 ≥ 19/20", async () => { const r = await measureClauseSearch(); assert.ok(r.correct >= 19, JSON.stringify(r.rows.filter((x) => !x.ok))); });
test("삭제 조항 오인용 0건", async () => assert.equal((await measureDeletionSafety()).miscitations, 0));
test("변경 영향 탐지 5/5, 대조군 오탐 0", async () => { const r = await measureImpact(); assert.deepEqual([r.detected, r.expected, r.false_positives], [5, 5, 0]); });

test("공개 법령 10건 구조 파싱 ≥ 99%", async () => {
  const { readdirSync, existsSync } = await import("node:fs");
  const { measurePublicLaw } = await import("./public-laws.ts");
  const dir = new URL("../../../../자료/데이터원천/법령/", import.meta.url);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
  assert.ok(files.length >= 10, "공개 법령 파일 누락 (자료/데이터원천/법령)");
  for (const f of files) {
    const r = measurePublicLaw(readFileSync(new URL(f, dir), "utf8"));
    assert.ok(r.accuracy >= 0.99, `${r.name} ${r.accuracy}`);
  }
});

test("Memory 평가 케이스(memory.jsonl): 기대 조문·상태·원문이 기준 데이터와 일치", async () => {
  const { regulationTools } = await import("@hanaeum/regulation-server");
  const { fixtureClauseStore } = await import("../../../../mcp/regulation-server/src/fixtures.ts");
  const t = regulationTools(fixtureClauseStore());
  const cases = readFileSync(new URL("../memory.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; turns: { as_of: string; expect: { provision_id?: string; status?: string; text_includes?: string } }[] });
  assert.equal(cases.length, 6);
  for (const c of cases) for (const turn of c.turns) {
    const e = turn.expect;
    if (!e.provision_id) continue;
    const r = await t.get_clause({ clause: e.provision_id, as_of: turn.as_of }, { sub: "eval", groups: ["USER"], dept: "여신" }) as { search_status: string; provision_id?: string; original_text?: string };
    assert.equal(r.search_status === "HISTORICAL" ? "FOUND" : r.search_status, e.status, `${c.id} ${e.provision_id}`);
    if (e.text_includes) assert.ok(r.original_text?.includes(e.text_includes), `${c.id} 원문에 ${e.text_includes}`);
  }
});
