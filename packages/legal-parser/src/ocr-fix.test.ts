import { test } from "node:test";
import assert from "node:assert/strict";
import { ocrRows, restoreCircled } from "./ocr-fix.ts";
import { parseLaw } from "./parse.ts";

// 공유 dev 실측(F-001, PaddleOCR korean PP-OCRv5): ①→"1", ③→"3", ②는 정상 인식
const OCR = [
  "제10조(심사 서류) 1 심사역은 다음 각 호의 서류를 받아야 한다.",
  "1. 최근 3년간 재무제표",
  "2. 사업자등록증 사본",
  "② 제1항제3호의 감정평가서는 발급일로부터 6개월 이내의 것이어야 한다.",
  "제12조(승인 기준) 1 여신 금액이 5억원 이상인 경우 본부 여신심사위원회의 승인을 받아야 한다.",
  "② 제1항에도 불구하고 예금담보대출은 영업점장이 승인할 수 있다.",
  "3신용등급이 B 이하인 차주는 여신 금액과 관계없이 본부 승인을 받아야 한다.",
  "제13조(심사 기록)심사 결과와 근거는 여신관리시스템에 5년간 보관한다.", // 쪽 첫 줄 공백 누락 (실측)
].join("\n");

test("restoreCircled: 앞 조보다 큰 번호의 인용이라도 괄호 뒤가 조사면 조 머리 아님", () => {
  assert.equal(restoreCircled("제3조(목적) 가.\n제15조(담보인정비율)에 따른 비율을 적용한다."), "제3조(목적) 가.\n제15조(담보인정비율)에 따른 비율을 적용한다.");
});

test("restoreCircled: 본문 속 조문 인용(번호 순서 안 맞음)은 조 머리로 바꾸지 않음, 부칙은 조 번호 초기화", () => {
  const t = "제10조(기준) 가.\n제10조(특례)에 따른 경우는 예외로 한다.\n제12조(기록)보관한다.\n부칙\n제1조(시행일)이 규정은 시행한다.";
  assert.equal(restoreCircled(t), "제10조(기준) 가.\n제10조(특례)에 따른 경우는 예외로 한다.\n제12조(기록) 보관한다.\n부칙\n제1조(시행일) 이 규정은 시행한다.");
});

test("restoreCircled: 실측 오인식(1→①, 3→③)을 순서 근거로 복원, 호(1.)는 그대로", () => {
  const fixed = restoreCircled(OCR).split("\n");
  assert.equal(fixed[0], "제10조(심사 서류) ① 심사역은 다음 각 호의 서류를 받아야 한다.");
  assert.equal(fixed[1], "1. 최근 3년간 재무제표");
  assert.equal(fixed[6], "③ 신용등급이 B 이하인 차주는 여신 금액과 관계없이 본부 승인을 받아야 한다.");
  assert.equal(fixed[7], "제13조(심사 기록) 심사 결과와 근거는 여신관리시스템에 5년간 보관한다.");
  const paths = parseLaw(fixed.join("\n"), { law_id: "X", law_name: "x", revision_id: "2026-01-01" }).provisions.map((p) => p.provision_id.split("/").slice(1).join("/"));
  for (const p of ["ARTICLE:10/PARAGRAPH:1/ITEM:1", "ARTICLE:10/PARAGRAPH:2", "ARTICLE:12/PARAGRAPH:3", "ARTICLE:13"]) assert.ok(paths.includes(p), p);
});

test("restoreCircled: 순서가 안 맞거나 숫자+단위면 바꾸지 않음 (오보정 방지)", () => {
  // 조 머리 없이 갑자기 3 → 그대로 / 3년간(단위) → 그대로 / 조가 바뀌면 번호 초기화
  assert.equal(restoreCircled("3신용등급이 낮다"), "3신용등급이 낮다");
  assert.equal(restoreCircled("제5조(보관) 1 기록은 보관한다.\n3년간 보관한다."), "제5조(보관) ① 기록은 보관한다.\n3년간 보관한다.");
  assert.equal(restoreCircled("제5조(보관) ① 가.\n② 나.\n제6조(확인) 2 다."), "제5조(보관) ① 가.\n② 나.\n제6조(확인) 2 다.");
  assert.equal(restoreCircled("제7조(목적) 이 규정은 목적을 정한다."), "제7조(목적) 이 규정은 목적을 정한다.", "항 없는 조");
});

test("ocrRows: 같은 높이 블록을 한 줄로 (항 번호 블록이 따로 잡혀도 본문과 합침)", () => {
  const b = (text: string, x: number, y: number) => ({ text, bbox: [x, y, x + 50, y + 40] });
  assert.deepEqual(ocrRows([b("심사역은 서류를 받는다.", 400, 101), b("1", 330, 100), b("제10조(심사 서류)", 40, 99)]), ["제10조(심사 서류) 1 심사역은 서류를 받는다."]);
});
