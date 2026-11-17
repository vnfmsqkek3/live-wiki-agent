import { test } from "node:test";
import assert from "node:assert/strict";
import { BedrockRewriter, cleanQuery, sanitize } from "./rewrite.ts";
import { retrieveMany } from "./search.ts";
import type { Hit, Retriever } from "./search.ts";

test("규칙: 요청 어미·관련 문서·질문 어미 제거, 다 지워지면 원문", () => {
  const cases: [string, string][] = [
    ["개인정보 관련된 문서들을 찾아줘", "개인정보"],
    ["개인정보 처리방법 알려주세요", "개인정보 처리방법"],
    ["감정평가서 유효기간은 어떻게 되나요?", "감정평가서 유효기간"],
    ["기업여신 승인 기준에 대한 자료 좀 보여줘", "기업여신 승인 기준"],
    ["개인정보", "개인정보"],
    ["찾아줘", "찾아줘"],
  ];
  for (const [q, want] of cases) assert.equal(cleanQuery(q), want, q);
});

test("모델 출력 검증: core 없으면 규칙 결과, alternates 중복·core 제거·2개까지·길이 제한", () => {
  assert.deepEqual(sanitize({ alternates: ["a"] }, "기본"), { core: "기본", alternates: ["a"] });
  assert.deepEqual(sanitize({ core: " x  y ", alternates: ["x y", "b", "b", "c", "d", 3] }, "z"), { core: "x y", alternates: ["b", "c"] });
  assert.equal(sanitize({ core: "가".repeat(300), alternates: [] }, "z").core.length, 100);
  assert.deepEqual(sanitize(undefined, "z"), { core: "z", alternates: [] });
});

test("모델 호출 실패는 검색 실패가 아님: 규칙 결과로 계속", async () => {
  const rw = new BedrockRewriter("m", { send: async () => { throw Object.assign(new Error("x"), { name: "ThrottlingException" }); } } as never);
  assert.deepEqual(await rw.rewrite("개인정보 관련 문서 찾아줘"), { core: "개인정보", alternates: [] });
});

test("여러 질의 병합: 같은 청크는 최고 점수와 그 질의, 근거 기준 통과가 weak보다 우선", async () => {
  const m = (doc: string) => ({ doc_id: doc, provision_id: "p1" });
  const table: Record<string, Hit[]> = {
    "개인정보 처리방법": [{ text: "A", score: 0.28, metadata: m("D1"), weak: true }],
    "개인정보 처리": [{ text: "A", score: 0.49, metadata: m("D1") }, { text: "B", score: 0.2, metadata: m("D2") }],
    "개인정보 처리 기준": [{ text: "B", score: 0.25, metadata: m("D2") }],
  };
  const r: Retriever = { retrieve: async (q) => table[q] ?? [] };
  const out = await retrieveMany(r, Object.keys(table), { equals: { key: "x", value: 1 } } as never);
  assert.deepEqual(out.map((h) => [h.metadata["doc_id"], h.score, h.matched_query, !!h.weak]), [
    ["D1", 0.49, "개인정보 처리", false],
    ["D2", 0.25, "개인정보 처리 기준", false],
  ]);
});
