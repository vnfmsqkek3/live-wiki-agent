import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixtureClauseStore } from "./fixtures.ts";
import { registryMatch } from "./registry.ts";
import { buildMarks, locate } from "./marks.ts";

const FIX = new URL("../../../tests/fixtures/", import.meta.url);
const read = (f: string) => readFileSync(new URL(f, FIX), "utf8").replace(/^---\n[\s\S]*?\n---\n/u, "");
const pdfHash = (id: string) => (JSON.parse(readFileSync(new URL("documents/pdf/hashes.json", FIX), "utf8")) as Record<string, string>)[id]!;
const span = (pages: string[], m: { page: number | null; start: number | null; end: number | null }) => pages[m.page!]!.slice(m.start!, m.end!);

test("locate: 공백·따옴표 차이를 무시하고 원래 글자 위치를 돌려준다", () => {
  const pages = ["첫 페이지", "여신  금액이\n5억원 이상인 경우 「본부」 승인"];
  const r = locate(pages, "여신 금액이 5억원 이상인 경우 본부 승인")!;
  assert.equal(r.page, 1);
  assert.equal(pages[1]!.slice(r.start, r.end), "여신  금액이\n5억원 이상인 경우 「본부」 승인");
  assert.equal(locate(pages, "없는 문장입니다"), null);
});

test("위조 규정 F-003: 공식 원본과 다른 조문에 밑줄, 근거=공식 원문, 수정 사항 제시", async () => {
  const s = fixtureClauseStore();
  const text = read("documents/F-003.txt");
  const pages = [text.slice(0, Math.floor(text.length / 2)), text.slice(Math.floor(text.length / 2))]; // 2페이지로 나눠도 위치를 찾는지
  const marks = await buildMarks(pages, { registry: await registryMatch(s, pdfHash("F-003"), text) }, s);
  assert.ok(marks.length > 0);
  for (const m of marks.filter((x) => x.kind === "REGISTRY_MISMATCH" && x.page !== null)) {
    assert.ok(span(pages, m).length > 0);
    assert.ok(m.basis?.text, "근거 원문");
    assert.equal(m.basis?.effective_from, "2026-11-01");
    assert.match(m.fix!, /공식 원문으로 수정|출처 확인/u);
  }
  // 정상 F-001: 해시 일치 → 밑줄 없음
  assert.deepEqual(await buildMarks([read("documents/F-001.txt")], { registry: await registryMatch(s, pdfHash("F-001")) }, s), []);
});

test("노하우: 개정 전 인용(K-003)·충돌(K-002)에 밑줄, 인용 대조 실패 충돌은 제외, Finding은 페이지 단위", async () => {
  const s = fixtureClauseStore();
  const k3 = [read("documents/K-003.md")];
  const [o] = await buildMarks(k3, { knowhow: { items: [], outdated: [{ cited: "SYN-LOAN-001@2025-01-01/ARTICLE:12/PARAGRAPH:1", current: "SYN-LOAN-001@2026-12-01/ARTICLE:12/PARAGRAPH:1", label: "한빛은행 기업여신 심사규정 제12조제1항" }] } }, s);
  assert.equal(o!.kind, "OUTDATED");
  assert.equal(span(k3, o!), "제12조제1항");
  assert.match(o!.fix!, /3억원/u);
  assert.equal(o!.basis?.effective_from, "2026-12-01");

  const k2 = [read("documents/K-002.md")];
  const stmt = "1억원 이하 부동산 담보대출은 현장 실사를 생략하고 감정평가서만으로 처리하면 하루 안에 끝낼 수 있다.";
  const item = { statement: stmt, provision_id: "SYN-LOAN-001@2026-11-01/ARTICLE:14/PARAGRAPH:1", relation: "CONFLICTS", reason: "부동산 담보는 현장 실사 필수", quote: "담보가 부동산인 경우 심사역은 현장 실사를 반드시 실시하여야 한다.", label: "제14조제1항" };
  const marks = await buildMarks(k2, {
    knowhow: { items: [{ ...item, verified_quote: true }, { ...item, verified_quote: false, statement: "SYNTHETIC" }], outdated: [] },
    findings: [{ severity: "MEDIUM", code: "PII_UNCERTAIN_PHONE", message: "전화번호 1건 확인 필요", evidence_ref: "page:0" }, { severity: "LOW", code: "PII_MASKED_PHONE", message: "x", evidence_ref: "page:0" }],
  }, s);
  const c = marks.filter((m) => m.kind === "CONFLICT");
  assert.equal(c.length, 1, "인용 원문 대조 실패한 충돌은 밑줄 없음");
  assert.equal(span(k2, c[0]!), stmt);
  assert.match(c[0]!.basis!.text, /현장 실사/u);
  const pii = marks.find((m) => m.kind === "PII_UNCERTAIN")!;
  assert.deepEqual([pii.page, pii.start], [0, null]);
  assert.equal(marks.length, 2, "확정 마스킹(PII_MASKED)은 밑줄 대상 아님");
});

test("리뷰 반영: 인젝션은 step으로 판별, PII_GUARDRAIL 포함, OUTDATED 조문 표기는 그 법령 근처 한 곳일 때만", async () => {
  const s = fixtureClauseStore();
  const f = await buildMarks(["본문"], { findings: [
    { step: "INJECTION_SCAN", severity: "HIGH", code: "OVERRIDE_KO", message: "지시 무시 문구", evidence_ref: "page:0" },
    { step: "PII_SCAN", severity: "MEDIUM", code: "PII_GUARDRAIL", message: "추가 검사 의심", evidence_ref: "page:0" },
  ] }, s);
  assert.deepEqual(f.map((m) => [m.kind, m.severity]), [["INJECTION", "HIGH"], ["PII_UNCERTAIN", "MEDIUM"]]);
  const o = { cited: "SYN-LOAN-001@2025-01-01/ARTICLE:12/PARAGRAPH:1", current: "SYN-LOAN-001@2026-12-01/ARTICLE:12/PARAGRAPH:1", label: "한빛은행 기업여신 심사규정 제12조제1항" };
  // 다른 법령의 같은 조문 표기만 있으면 문서 단위
  const [x] = await buildMarks(["「은행법」 제12조제1항에 따라 처리한다."], { knowhow: { items: [], outdated: [o] } }, s);
  assert.equal(x!.page, null);
});
