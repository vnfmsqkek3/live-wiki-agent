import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "./parse.ts";

test("표 행과 실패 줄을 항목·실패로", () => {
  const out = [
    "| 항목 | 목표 | 오프라인 측정 (20261216 기준) | 판정 |",
    "|---|---|---|---|",
    "| 정확 조문 검색 | 20건 중 19건 이상 | 18/20 | 미달 |",
    "| 삭제 조항 오인용 | 0건 | 0건 (조회 3 + 자유질의 4) | 통과 |",
    "| 승인 전 KB 가시성 | 0건 | AWS KB 배포 후 측정 | 미측정 |",
    "  조문 검색 실패 CL-07: got X / expected Y (lookup)",
  ].join("\n");
  const r = parse(out, "offline");
  assert.deepEqual(r.items.map((i) => [i.key, i.passed, i.total, i.pass]), [["clause_lookup_19_20", 18, 20, false], ["deleted_clause_0", 1, 1, true]]);
  assert.deepEqual(r.failures, [{ key: "clause_lookup_19_20", case_id: "CL-07", reason: "조문 검색 실패 CL-07: got X / expected Y (lookup)" }]);
});
