import { test } from "node:test";
import assert from "node:assert/strict";
import { cer, editDistance, rows, score } from "./measure-ocr.ts";

test("CER: 공백 무시 편집 거리 / 정답 글자 수", () => {
  assert.equal(editDistance("여신금액", "여산금액"), 1);
  assert.equal(cer("제12조 ① 5억원", "제12조①5억원"), 0, "띄어쓰기 차이는 오류 아님");
  assert.equal(cer("5억원 이상", "3억원 이상"), 1 / 5);
});

test("OCR 블록 → 줄: 같은 높이는 왼→오른으로 합치고 위→아래 순서", () => {
  const b = (text: string, x: number, y: number) => ({ text, bbox: [x, y, x + 100, y + 40] });
  assert.deepEqual(rows([b("심사규정", 300, 102), b("제1조(목적)", 40, 300), b("한빛은행", 40, 100)]), ["한빛은행 심사규정", "제1조(목적)"]);
});

test("score: 줄 정확 일치·조문 경로와 본문 일치 (숫자 오인식은 조문 불일치로 잡힘)", () => {
  const ref = ["제12조(승인 기준) ① 여신 금액이 5억원 이상인 경우 본부 승인을 받아야 한다.", "② 예금담보대출은 영업점장이 승인할 수 있다."];
  const ok = score(ref, ["제12조(승인 기준) ① 여신 금액이 5억원 이상인 경우 본부 승인을 받아야 한다.", "② 예금담보대출은 영업점장이 승인할 수 있다."]);
  assert.deepEqual([ok.cer, ok.lineExact, ok.provisionsMatched, ok.provisions], [0, 2, 3, 3]);
  const bad = score(ref, ["제12조(승인 기준) ① 여신 금액이 3억원 이상인 경우 본부 승인을 받아야 한다.", "② 예금담보대출은 영업점장이 승인할 수 있다."]);
  assert.equal(bad.lineExact, 1);
  assert.equal(bad.provisionsMatched, 2);
  assert.ok(bad.cer > 0 && bad.cer < 0.05);
});
