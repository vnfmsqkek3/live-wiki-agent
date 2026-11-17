import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { diffDocuments, docDates, previousVersionCandidates, primaryDate, similarity, titleCandidate } from "./docmeta.ts";

const read = (p: string) => readFileSync(new URL(`../../../tests/fixtures/${p}`, import.meta.url), "utf8").replace(/^---\n[\s\S]*?\n---\n/u, "");

test("문서 일자: 라벨 붙은 날짜만, 형식 여러 가지, 대표 일자는 시행 > 개정 > 작성", () => {
  const d = docDates(["개정일: 2026. 11. 1.\n<개정 2025-01-01>\n시행일자 2026년 12월 1일\n거래일 2026. 3. 3.\n작성 2026/02/30"]);
  assert.deepEqual(d.map((x) => [x.kind, x.date]), [["개정", "2026-11-01"], ["개정", "2025-01-01"], ["시행", "2026-12-01"]]); // 2/30은 없는 날
  assert.equal(primaryDate(d)?.date, "2026-12-01");
  assert.equal(primaryDate(d.filter((x) => x.kind === "개정"))?.date, "2026-11-01", "같은 종류는 최신");
  assert.ok(docDates([read("documents/F-001.txt")]).length > 0, "합성 규정 머리말의 시행일");
});

test("제목 후보: SYNTHETIC 표시줄·조문·문장 건너뜀, 없으면 파일 이름", () => {
  assert.equal(titleCandidate([read("documents/K-001.md")]), "부동산 담보평가 실무 노하우");
  assert.equal(titleCandidate(["SYNTHETIC — 하나은행 가상 데이터\n하나은행 기업여신 심사규정\n제1조(목적) 이 규정은…"]), "하나은행 기업여신 심사규정");
  assert.equal(titleCandidate(["① 영업점은 분기마다 자점감사를 실시하여야 한다."], "장애_대응_메모.pdf"), "장애 대응 메모");
});

test("같은 문서 판별: 개정본은 후보, 다른 문서는 제외", () => {
  const v1 = read("documents/F-001.txt"), v2 = read("documents/F-002.txt"), k1 = read("documents/K-001.md");
  assert.ok(similarity(v1, v2) >= 0.5, `개정본 유사도 ${similarity(v1, v2)}`);
  assert.ok(similarity(v1, k1) < 0.3, `다른 문서 유사도 ${similarity(v1, k1)}`);
  const c = previousVersionCandidates({ title: "기업여신 심사규정", text: v2 }, [{ doc_id: "A", title: "x", text: v1 }, { doc_id: "B", title: "y", text: k1 }]);
  assert.deepEqual(c.map((x) => x.doc_id), ["A"]);
  assert.equal(previousVersionCandidates({ title: "t", text: "", law_id: "L" }, [{ doc_id: "R", title: "r", text: "", law_id: "L" }])[0]?.reason, "같은 규정(법령 ID)");
});

test("버전 변경점: 규정은 조문 단위(수치 변화 포함), 노하우는 줄 단위·쪽 번호", () => {
  const ch = diffDocuments([read("documents/F-001.txt")], [read("documents/F-002.txt")]);
  const a12 = ch.find((c) => c.where.includes("제12조제1항"))!;
  assert.equal(a12.kind, "CHANGED");
  assert.deepEqual(a12.numbers_changed, { old: ["5억원"], new: ["3억원"] });
  const old = ["# 메모\n1. 감정평가서를 확인한다.\n2. 결과를 남긴다.", "3. 사진을 첨부한다."];
  const neu = ["# 메모\n1. 감정평가서를 6개월 이내인지 확인한다.\n2. 결과를 남긴다.", "3. 사진을 첨부한다.\n4. 팀장에게 보고한다."];
  assert.deepEqual(diffDocuments(old, neu).map((c) => [c.kind, c.where, c.old_text, c.new_text]), [
    ["CHANGED", "1쪽", "1. 감정평가서를 확인한다.", "1. 감정평가서를 6개월 이내인지 확인한다."],
    ["ADDED", "2쪽", "", "4. 팀장에게 보고한다."],
  ]);
  assert.deepEqual(diffDocuments(old, old), []);
});
