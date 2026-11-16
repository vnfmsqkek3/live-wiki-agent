import { test } from "node:test";
import assert from "node:assert/strict";
import { ProvisionId } from "@hanaeum/schemas";
import { parseLaw, circledToInt } from "./index.ts";
import { readFixture, readFixtureJson } from "./fixtures.ts";

interface Expected {
  meta: { law_id: string; law_name: string; revision_id: string };
  provisions: [string, string][];
  references: { from: string; to: string; exception_candidate?: boolean }[];
  amendments: Record<string, [string, string[]][]>;
  deletion_dates: Record<string, string>;
}
const exp = readFixtureJson<Expected>("legal/expected/L-001.json");
const law = parseLaw(readFixture("legal/source/L-001.txt"), exp.meta);
const B = `${exp.meta.law_id}@${exp.meta.revision_id}/`;
const byId = new Map(law.provisions.map((p) => [p.provision_id, p]));

test("L-001 구조: 정답과 완전 일치 (조·항·호·목 경로 + 상태)", () => {
  const got = law.provisions.map((p) => [p.provision_id.slice(B.length), p.status]);
  assert.deepEqual(got, exp.provisions);
});

test("모든 provision_id가 공유 스키마 ID 규칙을 만족", () => {
  for (const p of law.provisions) assert.ok(ProvisionId.safeParse(p.provision_id).success, p.provision_id);
});

test("참조 해석: 절대·상대·별표·부칙→본칙·예외 후보", () => {
  for (const r of exp.references) {
    const refs = byId.get(B + r.from)!.references;
    const hit = refs.find((x) => x.target_id === B + r.to);
    assert.ok(hit, `${r.from} → ${r.to} 없음: ${JSON.stringify(refs)}`);
    if (r.exception_candidate) assert.equal(hit.exception_candidate, true, `${r.from} 예외 후보`);
  }
});

test("개정 태그 여러 날짜·삭제일·이동 태그·본조신설", () => {
  for (const [id, a] of Object.entries(exp.amendments)) {
    assert.deepEqual(byId.get(B + id)!.amendments.map((x) => [x.kind, x.dates]), a);
  }
  for (const [id, d] of Object.entries(exp.deletion_dates)) assert.equal(byId.get(B + id)!.deletion_date, d);
  assert.equal(byId.get(B + "ARTICLE:12/PARAGRAPH:11")!.tail_tags["moved_from"], "제9항");
  assert.equal(byId.get(B + "ARTICLE:12-2")!.tail_tags["본조신설"], "2013. 12. 3.");
  assert.ok(!byId.get(B + "ARTICLE:1")!.normalized_text.includes("<개정"), "태그는 본문에서 분리");
});

test("가지번호: 제12조의2 ≠ 제12조제2항, 본문 인용 줄은 조로 분할하지 않음", () => {
  assert.equal(byId.get(B + "ARTICLE:12-2")!.path_label, "제12조의2");
  assert.ok(!byId.has(B + "ARTICLE:5"));
  assert.match(byId.get(B + "ARTICLE:14")!.normalized_text, /제5조제1항에 따라/u);
});

test("이슈 큐: 번호 불연속·미해결 참조를 보고", () => {
  const codes = law.issues.map((i) => i.code);
  assert.ok(codes.includes("NUMBER_REGRESSION")); // "11." 불연속 호
  assert.ok(law.issues.some((i) => i.code === "UNRESOLVED_REF" && i.message.includes("제5조제1항")));
  assert.ok(!codes.includes("DUPLICATE_ID"));
});

test("원문 보존·정규화 분리, 삭제 조문 본문 비움", () => {
  const p = byId.get(B + "ARTICLE:12/PARAGRAPH:4")!;
  assert.match(p.original_text, /삭제 <2025\. 1\. 1\.>/u);
  assert.equal(p.normalized_text, "");
  assert.equal(circledToInt("⑪"), 11);
  assert.equal(circledToInt("㉑"), 21);
});

test("인라인 엣지 케이스: 불규칙 띄어쓰기·가운뎃점", () => {
  const l = parseLaw("제1조(목적) 「가상법」제2조 및 제3조ㆍ제4조를 따른다.\n제2조(기타) 내용", { law_id: "SYN-X-1", law_name: "가상테스트법", revision_id: "2026-01-01" });
  const refs = l.provisions[0]!.references;
  assert.equal(refs.find((r) => r.kind === "EXTERNAL")!.raw, "「가상법」제2조");
  // 내부 제3조는 존재하지 않으므로 미해결(null) — 지어내지 않는다
  assert.equal(refs.find((r) => r.raw === "제3조")!.target_id, null);
  assert.equal(refs.filter((r) => r.kind === "EXTERNAL").length, 1);
  assert.match(l.provisions[0]!.normalized_text, /제3조·제4조/u);
});
