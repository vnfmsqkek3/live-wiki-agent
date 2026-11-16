import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixtureClauseStore } from "./fixtures.ts";
import { regulationTools } from "./tools.ts";
import { lawUrl, parseHeader } from "./browser.ts";
import type { LawPageFetcher } from "./browser.ts";

const FIX = new URL("../../../tests/fixtures/", import.meta.url);

test("국가법령정보센터 머리말 파싱", () => {
  assert.deepEqual(parseHeader("은행법\n[시행 2026. 7. 1.] [법률 제21296호, 2025. 12. 30., 일부개정]"), { effective_from: "2026-07-01", promulgation: "법률 제21296호" });
  assert.equal(lawUrl(" 은행법 "), "https://www.law.go.kr/법령/%EC%9D%80%ED%96%89%EB%B2%95");
});

test("fetch_official_law: 요청 조문 원문 + 저장본 대비 개정 감지, 결과는 UNVERIFIED", async () => {
  // 웹 원문 대역: 저장된 최신 개정본(F-002)보다 늦은 시행일로 가정한 F-002 본문 (본문은 같아도 v1 대비 변경이 잡힘)
  const visited: string[] = [];
  const fetcher: LawPageFetcher = { fetch: async (n) => { visited.push(n); return { url: lawUrl(n), header: "[시행 2027. 1. 1.] [규정 제3호, 2026. 12. 20., 일부개정]", body: readFileSync(new URL("documents/F-002.txt", FIX), "utf8") }; } };
  const t = regulationTools(fixtureClauseStore(), { fetcher });
  const r = await t.fetch_official_law({ law_name: "한빛은행 기업여신 심사규정", clause: "제12조제1항" });
  assert.equal(r.authority_status, "UNVERIFIED");
  assert.equal(r.effective_from, "2027-01-01");
  assert.match(r.clause!.text, /원/u);
  assert.ok(r.stored, "저장된 같은 법령과 비교");
  assert.equal(r.stored!.newer_official, true);
  // URL·임의 문자열 거부 (허용 사이트 밖 접근 차단)
  await assert.rejects(t.fetch_official_law({ law_name: "https://evil.example/x" }), /law_name/u);
  assert.deepEqual(visited, ["한빛은행 기업여신 심사규정"]);
  // Browser 미설정이면 Tool 비활성
  await assert.rejects(regulationTools(fixtureClauseStore()).fetch_official_law({ law_name: "은행법" }), /Browser/u);
});

test("externalLaws: 내부 저장소에 없는 「법령」 인용만 → 비면 Browser 실행 안 함", async () => {
  const { externalLaws } = await import("./browser.ts");
  const s = fixtureClauseStore();
  const t = "「은행법」 제30조에 따라 … 「한빛은행 기업여신 심사규정」 제12조 … 「여신거래기본약관」 서식 … 「예금자보호법」 「은행법」";
  assert.deepEqual(await externalLaws(t, s), ["은행법", "예금자보호법"]);
  assert.deepEqual(await externalLaws("한빛은행 기업여신 심사규정 제12조에 따른 승인 기준", s), [], "외부 법령 인용 없으면 빈 목록");
});

test("cachedFetcher: 1일 안에 같은 법령은 Browser 재실행 없이 캐시, 지나면 다시 조회", async () => {
  const { cachedFetcher, fetchOfficialLaw } = await import("./browser.ts");
  const store = new Map<string, { url: string; header: string; body: string; fetched_at: string }>();
  const cache = { get: async (n: string) => store.get(n), put: async (n: string, p: { url: string; header: string; body: string }, at: string) => { store.set(n, { ...p, fetched_at: at }); } };
  let calls = 0;
  const inner: LawPageFetcher = { fetch: async (n) => { calls++; return { url: lawUrl(n), header: "[시행 2026. 7. 1.] [법률 제1호, 2026. 1. 1., 일부개정]", body: "제1조(목적) 목적." }; } };
  let clock = Date.parse("2026-11-16T00:00:00Z");
  const f = cachedFetcher(inner, cache, () => new Date(clock));
  const s = fixtureClauseStore();
  const a = await fetchOfficialLaw(f, s, { law_name: "은행법" });
  clock += 3600_000;
  const b = await fetchOfficialLaw(f, s, { law_name: "은행법" });
  assert.equal(calls, 1);
  assert.deepEqual([a.from_cache, b.from_cache], [false, true]);
  assert.equal(b.fetched_at, "2026-11-16T00:00:00.000Z", "캐시 결과는 원래 조회 시각 표시");
  clock += 24 * 3600_000;
  assert.equal((await fetchOfficialLaw(f, s, { law_name: "은행법" })).from_cache, false);
  assert.equal(calls, 2);
});
