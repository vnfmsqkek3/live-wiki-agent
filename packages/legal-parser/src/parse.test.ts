import { test } from "node:test";
import assert from "node:assert/strict";
import { ProvisionId } from "@hanaeum/schemas";
import { parseLaw, circledToInt } from "./parse.ts";
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

test("본문 줄 머리의 \"제N조(제목)에 따른\" 인용은 조로 분할하지 않음", () => {
  const l = parseLaw("제1조(목적) 목적을 정한다.\n① 첫째 항.\n제10조(특례)에 따른 경우는 예외로 한다.\n② 기타.\n제3조(기타) 끝.", { law_id: "SYN-X-2", law_name: "가상", revision_id: "2026-01-01" });
  const ids = l.provisions.map((p) => p.provision_id.split("/").slice(1).join("/"));
  assert.ok(!ids.includes("ARTICLE:10"));
  assert.ok(ids.includes("ARTICLE:1/PARAGRAPH:2"));
  assert.match(l.provisions.find((p) => p.provision_id.endsWith("PARAGRAPH:1"))!.normalized_text, /제10조\(특례\)에 따른/u);
});

test("공개 법령에서 발견한 엣지 케이스: 관 계층, 제목 안 괄호, <16> 항 표기, 호환 한자 원문 보존", () => {
  const txt = [
    "제3편 채권", "제1장 총칙", "제3절 수인의 채권자 및 채무자", "제2관 불가분채권과 불가분채무",
    "제50조(분사무소(分事務所) 설치의 등기) 법인이 분사무소를 설치한 경우에는 등기하여야 한다.",
    "제51조(정의) ⑮ 열다섯째 항.", // 번호 불연속 → 이슈
    "제52조(항 많음) ① 첫째", ...Array.from({ length: 14 }, (_, i) => `${"②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮"[i]} 항`), "<16> <16> 열여섯째 항.", "1. 첫째 호",
    "제53조(결격) 파산선고를 받고 복復(復權)되지 아니한 사람",
  ].join("\n");
  const l = parseLaw(txt, { law_id: "SYN-K-1", law_name: "가상", revision_id: "2026-01-01" });
  const by = new Map(l.provisions.map((p) => [p.provision_id.split("/").slice(1).join("/"), p]));
  assert.equal(by.get("ARTICLE:50")!.title, "분사무소(分事務所) 설치의 등기");
  assert.match(by.get("ARTICLE:50")!.normalized_text, /^법인이 분사무소를/u);
  assert.deepEqual(by.get("ARTICLE:50")!.heading_path.at(-1), "제2관 불가분채권과 불가분채무");
  assert.equal(by.get("ARTICLE:52/PARAGRAPH:16")!.original_marker, "<16>");
  assert.equal(by.get("ARTICLE:52/PARAGRAPH:16")!.normalized_text, "열여섯째 항.");
  assert.ok(by.has("ARTICLE:52/PARAGRAPH:16/ITEM:1"));
  assert.ok(by.get("ARTICLE:53")!.original_text.includes("復"), "원문 glyph(호환 한자) 보존");
  assert.ok(!by.get("ARTICLE:53")!.normalized_text.includes("復"), "정규화 본문은 NFC");
});

test("타법개정 부칙 머리(법령명 괄호)도 부칙으로 인식 — 국가법령정보센터 웹 원문 형식", () => {
  const t = ["제1조(목적) 목적.", "제2조(정의) 정의.", " 부  칙 <법률 제5982호, 1999. 5. 24.> (정부조직법)", "제1조 (시행일) 이 법은 공포한 날부터 시행한다.", "제2조 생략"].join("\n");
  const law = parseLaw(t, { law_id: "X", law_name: "x", revision_id: "2026-01-01" });
  assert.deepEqual(law.issues.filter((i) => i.code === "NUMBER_REGRESSION"), []);
  assert.ok(law.provisions.some((p) => p.provision_id === "X@2026-01-01/SUPPLEMENTARY:1/ARTICLE:2"));
});

test("OCR 공백 누락: '제2장심사 절차'도 장 제목, 본문 줄은 제목으로 잡지 않음 (11/17 실측, PR #26 리뷰)", () => {
  const meta0 = { law_id: "SYN-X", law_name: "x", revision_id: "2026-11-01" };
  // 본문 줄: 앞 조문 본문에 그대로 남아야 함
  for (const body of ["제2장, 제3장은 적용하지 아니한다.", "제2장·제3장에 따른 절차", "제2장중 제5조를 삭제한다.", "제2장으로", "제2장인 경우", "제2장(심사 절차)", "제2장에 따른 서류", "제2장에따른 서류", "제2장의규정은 적용 제외", "제2장을준용"]) {
    const l0 = parseLaw(`제1조(적용) 이 규정은\n${body}\n제3조(기타) 끝.`, meta0);
    assert.ok(l0.provisions.find((p) => p.provision_id.endsWith("ARTICLE:1"))!.normalized_text.includes(body.slice(0, 4)), body);
    assert.deepEqual(l0.provisions.find((p) => p.provision_id.endsWith("ARTICLE:3"))!.heading_path, [], body);
  }
  // 공백 없는 진짜 제목 (첫 글자가 조사와 같아도 뒤에 글자가 이어지면 제목)
  for (const h of ["제2장이사회", "제2장가계대출", "제3장만기 관리"]) {
    assert.deepEqual(parseLaw(`${h}\n제1조(목적) 끝.`, meta0).provisions[0]!.heading_path, [h], h);
  }
  // 공백 있는 긴 제목은 길이 제한 없음 (기존 동작)
  const long = "제2장 여신 심사 및 승인 절차와 사후 관리에 관한 세부 사항을 정하는 장";
  assert.deepEqual(parseLaw(`${long}\n제1조(목적) 끝.`, meta0).provisions[0]!.heading_path, [long]);
  const meta = { law_id: "SYN-X", law_name: "x", revision_id: "2026-11-01" };
  const l = parseLaw("제1조(목적) 이 규정은 목적을 정한다.\n제2장심사 절차\n제2조(심사) 심사역은 제2장에 따른 서류를 확인한다.", meta);
  assert.equal(l.provisions.find((p) => p.provision_id.endsWith("ARTICLE:1"))!.normalized_text.includes("제2장"), false);
  assert.match(l.provisions.find((p) => p.provision_id.endsWith("ARTICLE:2"))!.heading_path.join(), /심사 절차/u);
  assert.ok(l.provisions.find((p) => p.provision_id.endsWith("ARTICLE:2"))!.normalized_text.includes("제2장에 따른"));
});

test("OCR 줄 '제2 관리자는…'은 제목이 아니라 본문으로 남음 (PR #28 리뷰)", () => {
  const meta = { law_id: "SYN-X", law_name: "x", revision_id: "2026-11-01" };
  const l = parseLaw("제1조(점검) 이 규정에 따라\n제2 관리자는 다음 사항을 점검하여", meta);
  assert.match(l.provisions[0]!.normalized_text, /관리자는/u);
});
