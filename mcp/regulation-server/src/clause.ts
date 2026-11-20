// 조문 표현("제12조제2항제3호가목", "부칙 제1조", provision_id) → 버전 무관 상대 경로. regulation Tool·Browser Tool 공용
import { SUBITEM_CODES } from "@hanaeum/schemas";
import type { SubitemChar } from "@hanaeum/schemas";
import { ToolError } from "@hanaeum/mcp-kit";
import { relPath } from "./store.ts";

const SUB = Object.keys(SUBITEM_CODES).join("");
export const CLAUSE_EXPR = new RegExp(`^(부칙\\s*)?제(\\d+)(?:-(\\d+)조(?:의(\\d+))?|조(?:의(\\d+))?)(?:\\s*제(\\d+)항)?(?:\\s*제(\\d+)호(?:의(\\d+))?)?(?:\\s*([${SUB}])목)?$`, "u");

/** "제12조제2항제3호가목" 또는 provision_id → 버전 무관 상대 경로 */
export function clausePath(expr: string): string {
  const e = expr.trim();
  if (e.includes("/ARTICLE:") || /^(?:SUPPLEMENTARY:\d+\/)?ARTICLE:/u.test(e)) return e.includes("@") ? relPath(e) : e;
  const m = e.replace(/\s+/gu, "").match(CLAUSE_EXPR) ?? e.match(CLAUSE_EXPR);
  if (!m) throw new ToolError("INVALID_ARGUMENT", `조문 표현을 해석할 수 없음: ${expr}`);
  const [, supp, a, dashB, dashB2, uiB, p, i, ib, s] = m; // 제9-5조 = 제9조의5 (ARTICLE:9-5), 제2-1조의2 = ARTICLE:2-1-2
  const ab = dashB ? (dashB2 ? `${dashB}-${dashB2}` : dashB) : uiB;
  let path = `${supp ? "SUPPLEMENTARY:*/" : ""}ARTICLE:${a}${ab ? `-${ab}` : ""}`;
  if (p) path += `/PARAGRAPH:${p}`;
  if (i) path += `/ITEM:${i}${ib ? `-${ib}` : ""}`;
  if (s) path += `/SUBITEM:${SUBITEM_CODES[s as SubitemChar]}`;
  return path;
}

