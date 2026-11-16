import { test } from "node:test";
import assert from "node:assert/strict";
import { maskPii, isDate, actorFrom, aclKeys } from "./index.ts";

test("PII 치환: 날짜는 계좌번호로 오탐하지 않음 (dhxorb96 요청 1912 재현 케이스)", () => {
  assert.deepEqual(maskPii("2026-11-01 시행 기준 담보 승인"), { text: "2026-11-01 시행 기준 담보 승인", masked: false });
  assert.equal(maskPii("2025-1-1 이전 규정").text, "2025-1-1 이전 규정");
  assert.equal(maskPii("계좌 110-123-456789로 입금").text, "계좌 [계좌번호]로 입금");
  assert.equal(maskPii("2026-13-40 은 날짜 아님").text, "[계좌번호] 은 날짜 아님");
  assert.equal(maskPii("연락처 010-1234-5678, 주민 900101-1234567, a@b.com").text, "연락처 [전화번호], 주민 [주민번호], [이메일]");
  assert.ok(isDate("2026-02-28") && !isDate("2026-02-30"));
});

test("신원: event.__actor만 신뢰, 역할 외 그룹은 버림, ACL 키에 DEPT#", () => {
  assert.throws(() => actorFrom({ actor: { sub: "x", groups: ["USER"] } }), /사용자 컨텍스트/u);
  const a = actorFrom({ __actor: { sub: "u", groups: ["USER", "ADMIN_HACK", "DEPT#여신"], dept: "여신" } });
  assert.deepEqual(a.groups, ["USER", "DEPT#여신"]);
  assert.deepEqual(aclKeys(a), ["ALL", "USER", "DEPT#여신", "DEPT#여신"]);
});
