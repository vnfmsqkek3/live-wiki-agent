import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixtureClauseStore } from "./fixtures.ts";
import { regulationTools } from "./tools.ts";
import { lawUrl, parseHeader } from "./browser.ts";
import { checkUrl } from "./browser.ts";
import type { LawPageFetcher } from "./browser.ts";

const FIX = new URL("../../../tests/fixtures/", import.meta.url);

test("국가법령정보센터 머리말 파싱", () => {
  assert.deepEqual(parseHeader("은행법\n[시행 2026. 7. 1.] [법률 제21296호, 2025. 12. 30., 일부개정]"), { effective_from: "2026-07-01", promulgation: "법률 제21296호" });
  assert.equal(lawUrl(" 은행법 "), "https://www.law.go.kr/법령/%EC%9D%80%ED%96%89%EB%B2%95");
  assert.equal(lawUrl("외국환거래규정"), `https://www.law.go.kr/행정규칙/${encodeURIComponent("외국환거래규정")}`);
  assert.equal(parseHeader("[시행 2025. 7. 1.] [기획재정부고시 제2025-12호, 2025. 6. 30., 일부개정]").promulgation, "기획재정부고시 제2025-12호");
});

test("fetch_official_law: 요청 조문 원문 + 저장본 대비 개정 감지, 결과는 UNVERIFIED", async () => {
  // 웹 원문 대역: 저장된 최신 개정본(F-002)보다 늦은 시행일로 가정한 F-002 본문 (본문은 같아도 v1 대비 변경이 잡힘)
  const visited: string[] = [];
  const fetcher: LawPageFetcher = { fetch: async (n) => { visited.push(n); return { url: lawUrl(n), header: "[시행 2027. 1. 1.] [규정 제3호, 2026. 12. 20., 일부개정]", body: readFileSync(new URL("documents/F-002.txt", FIX), "utf8") }; } };
  const t = regulationTools(fixtureClauseStore(), { fetcher });
  const r = await t.fetch_official_law({ law_name: "하나은행 기업여신 심사규정", clause: "제12조제1항" });
  assert.equal(r.authority_status, "UNVERIFIED");
  assert.equal(r.effective_from, "2027-01-01");
  assert.match(r.clause!.text, /원/u);
  assert.ok(r.stored, "저장된 같은 법령과 비교");
  assert.equal(r.stored!.newer_official, true);
  // URL·임의 문자열 거부 (허용 사이트 밖 접근 차단)
  await assert.rejects(t.fetch_official_law({ law_name: "https://evil.example/x" }), /law_name/u);
  assert.deepEqual(visited, ["하나은행 기업여신 심사규정"]);
  // Browser 미설정이면 Tool 비활성
  await assert.rejects(regulationTools(fixtureClauseStore()).fetch_official_law({ law_name: "은행법" }), /Browser/u);
});

test("externalLaws: 내부 저장소에 없는 「법령」 인용만 → 비면 Browser 실행 안 함", async () => {
  const { externalLaws } = await import("./browser.ts");
  const s = fixtureClauseStore();
  const t = "「은행법」 제30조에 따라 … 「하나은행 기업여신 심사규정」 제12조 … 「여신거래기본약관」 서식 … 「예금자보호법」 「은행법」";
  assert.deepEqual(await externalLaws(t, s), ["은행법", "예금자보호법"]);
  assert.deepEqual(await externalLaws("하나은행 기업여신 심사규정 제12조에 따른 승인 기준", s), [], "외부 법령 인용 없으면 빈 목록");
});

test("externalLawRefs: [ ]·『』 괄호도 법령명으로, 바로 뒤 조문 표기 (사용자 지적 11/18 '[개인정보 보호법]제15조제1항')", async () => {
  const { externalLawRefs } = await import("./browser.ts");
  const s = fixtureClauseStore();
  const t = "수집 시 [개인정보 보호법]제15조제1항에 따라 동의를 받는다. 『신용정보의 이용 및 보호에 관한 법률』 제 32 조 참고. [첨부 1] 서식, [개인정보 보호법]";
  assert.deepEqual(await externalLawRefs(t, s), [
    { law_name: "개인정보 보호법", clause: "제15조제1항", clauses: ["제15조제1항"] },
    { law_name: "신용정보의 이용 및 보호에 관한 법률", clause: "제32조", clauses: ["제32조"] },
  ]);  // 대괄호 소제목은 조문 표기가 없으면 법령 아님, "방법·요령·명령"은 법령명 아님 (PR #47 리뷰)
  assert.deepEqual(await externalLawRefs("[신청 방법] 1. 접수 [작성 요령] [업무 지시 명령] [보안 규칙] [은행법] 참고 [처리방법]제3조", s), []);
  assert.deepEqual(await externalLawRefs("「은행법」 참고", s), [{ law_name: "은행법", clauses: [] }]);
});

test("externalLawRefs: 괄호 없는 행정규칙명 + 가지번호 조문 (사용자 문서 11/20 '(외국환거래규정 제9-5\n조제1항)')", async () => {
  const { externalLawRefs } = await import("./browser.ts");
  const s = fixtureClauseStore();
  const t = "신고해요. (외국환거래규정 제9-5\n조제1항)\n서류를 받아요. (제9-5조제3항)\n외국환거래법 제18조제1항에 따라 … 근거하여 은행법 제5조 … (하나은행 기업여신 심사규정 제12조) (업무 규정)";
  assert.deepEqual(await externalLawRefs(t, s), [
    { law_name: "외국환거래규정", clause: "제9-5조제1항", clauses: ["제9-5조제1항", "제9-5조제3항"] },  // 법령명 없는 "(제9-5조제3항)"은 앞 법령
    { law_name: "외국환거래법", clause: "제18조제1항", clauses: ["제18조제1항"] },
  ]);  // 앞 낱말과 이어진 "은행법"·내부 규정·조문 없는 괄호는 제외
  assert.deepEqual(await externalLawRefs("「외국환거래규정」 제9-9조의2 참고", s), [{ law_name: "외국환거래규정", clause: "제9-9조의2", clauses: ["제9-9조의2"] }]);
});

test("externalLawRefs: 사용자 문서 fixture(M-002·M-003·변형본) → manifest expected_external_laws", async () => {
  const { externalLawRefs } = await import("./browser.ts");
  const { readFileSync } = await import("node:fs");
  const root = new URL("../../../tests/fixtures/", import.meta.url);
  const m = JSON.parse(readFileSync(new URL("documents/manifest.json", root), "utf8")) as { user_documents: { document_id: string; file: string; expected_external_laws: unknown[] }[] };
  for (const d of m.user_documents) {
    const text = readFileSync(new URL(d.file, root), "utf8");
    assert.ok(text.includes("SYNTHETIC — 하나은행 가상 데이터"), d.document_id);
    assert.deepEqual(await externalLawRefs(text, fixtureClauseStore()), d.expected_external_laws, d.document_id);
  }
});

test("clausePath: 가지번호 제9-5조 = 제9조의5 경로", async () => {
  const { clausePath } = await import("./clause.ts");
  assert.equal(clausePath("제9-5조제1항"), "ARTICLE:9-5/PARAGRAPH:1");
  assert.equal(clausePath("제 9-9 조 제1항 제8호"), "ARTICLE:9-9/PARAGRAPH:1/ITEM:8");
  assert.equal(clausePath("제12조의2제3항"), "ARTICLE:12-2/PARAGRAPH:3");
});

test("fetchOfficialLaw: 행정규칙 외국환거래규정 제9-5조제1항 원문 (AI팀 요청 11/20, 본문은 합성 mock)", async () => {
  const { fetchOfficialLaw } = await import("./browser.ts");
  const body = "제9-4조(투자금 회수) ① 투자원금과 과실은 회수한다.\n제9-5조(해외직접투자의 신고) ① 해외직접투자를 하려는 거주자는 지정거래외국환은행에 신고하여야 한다.\n② 사후보고할 수 있다.\n제9-9조(사후관리) ① 다음 각 호의 보고서를 제출하여야 한다.\n1. 송금보고서";
  let url = "";
  const fetcher: LawPageFetcher = { fetch: async (n) => { url = lawUrl(n); return { url, header: "[시행 2025. 7. 1.] [기획재정부고시 제2025-12호, 2025. 6. 30., 일부개정]", body }; } };
  const r = await fetchOfficialLaw(fetcher, fixtureClauseStore(), { law_name: "외국환거래규정", clause: "제9-5조제1항" });
  assert.ok(url.includes("/행정규칙/"));
  assert.equal(r.clause?.path, "ARTICLE:9-5/PARAGRAPH:1");
  assert.match(r.clause?.text ?? "", /지정거래외국환은행에 신고/u);
  assert.equal(r.parse_issues, 0);
});

test("externalLawRefs: 지시어·일반 명칭은 법령 아님, 호 목록은 조문에 포함 (PR #75 데이터QA·백엔드 11/20)", async () => {
  const { externalLawRefs } = await import("./browser.ts");
  const none = { lawIdByName: async () => undefined } as unknown as Parameters<typeof externalLawRefs>[1];
  for (const t of ["(시행령 제5조)", "(본규정 제3조)", "규정 제5조에 따라", "(동법 제3조)", "(같은법 제3조)", "(이 규정 제3조)", "(당행규정 제3조)"]) assert.deepEqual(await externalLawRefs(t, none), [], t);
  assert.deepEqual(await externalLawRefs("(이자제한법 제2조제1항)", none), [{ law_name: "이자제한법", clause: "제2조제1항", clauses: ["제2조제1항"] }]);
  assert.deepEqual(await externalLawRefs("(외국환거래규정 제9-9조제1항)\n(제9-4조제1항)\n(제9-9조제1항제8호·제9호)", none),
    [{ law_name: "외국환거래규정", clause: "제9-9조제1항", clauses: ["제9-9조제1항", "제9-4조제1항", "제9-9조제1항제8호", "제9-9조제1항제9호"] }]);
  const { clausePath } = await import("./clause.ts");
  assert.equal(clausePath("제9-9조제1항제9호"), "ARTICLE:9-9/PARAGRAPH:1/ITEM:9");
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

test("fetch_official_law: 가지 조문·호·목 표현도 공용 clausePath로 해석 (축소판 제거)", async () => {
  const body = "제1조(목적) 목적.\n제12조의2(특례) ① 다음 각 호를 따른다.\n1. 첫째\n가. 세부";
  const fetcher: LawPageFetcher = { fetch: async (n) => ({ url: lawUrl(n), header: "[시행 2026. 7. 1.] [법률 제1호, 2026. 1. 1., 일부개정]", body }) };
  const t = regulationTools(fixtureClauseStore(), { fetcher });
  assert.match((await t.fetch_official_law({ law_name: "은행법", clause: "제12조의2제1항제1호가목" })).clause!.text, /^가\. 세부$/u);
  assert.equal((await t.fetch_official_law({ law_name: "은행법", clause: "승인 기준" })).clause, null, "해석 불가 표현은 null");
});

test("readPage 주소 검사: http(s)만, 내부 주소 거부, 허용 목록 (PR #40 리뷰)", () => {
  assert.equal(checkUrl("https://www.samsung.com/sec/support/").host, "www.samsung.com");
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "http://localhost:8080", "http://169.254.169.254/latest", "http://10.0.0.1", "http://[::1]/", "http://intranet/", "http://svc.internal/", "not a url"]) {
    assert.throws(() => checkUrl(bad), { name: "BlockedUrl" }, bad);
  }
  assert.equal(checkUrl("https://www.law.go.kr/법령/은행법", ["www.law.go.kr"]).hostname, "www.law.go.kr");
  assert.throws(() => checkUrl("https://evil.example.com", ["www.law.go.kr"]), { name: "BlockedUrl" });
});

test("법령 원문 캐시 (prod 11/20 P0): 저장 실패해도 조회 결과는 돌려주고, 본문은 gzip 으로 저장해 400KB 한도 안", async () => {
  const { cachedFetcher } = await import("./browser.ts");
  const { DynamoLawPageCache } = await import("./store.ts");
  const body = "제9조의5(지급등의 절차) ① 외국환은행은 신고 여부를 확인하여야 한다.\n".repeat(8000); // UTF-8 약 700KB
  assert.ok(Buffer.byteLength(body) > 400_000);
  const inner: LawPageFetcher = { fetch: async (n) => ({ url: lawUrl(n), header: "[시행 2026. 7. 1.]", body }) };
  const failing = { get: async () => undefined, put: async () => { throw Object.assign(new Error("Item size has exceeded the maximum allowed size"), { name: "ValidationException" }); } };
  const r = await cachedFetcher(inner, failing).fetch("외국환거래규정");
  assert.equal(r.body, body); assert.equal(r.from_cache, false);
  // DynamoDB 저장 형식: body 대신 body_gz, 읽을 때 원문 복원
  const items = new Map<string, Record<string, unknown>>();
  const c = new DynamoLawPageCache("t");
  (c as unknown as { db: unknown }).db = { send: async (cmd: { input: { Item?: Record<string, unknown>; Key?: { pk: string } } }) => {
    if (cmd.input.Item) { items.set(String(cmd.input.Item["pk"]), cmd.input.Item); return {}; }
    return { Item: items.get(cmd.input.Key!.pk) };
  } };
  await c.put("외국환거래규정", { url: "u", header: "h", body }, "2026-11-20T00:00:00Z");
  const it = items.get("WEBLAW#외국환거래규정")!;
  assert.equal(it["body"], undefined); assert.ok((it["body_gz"] as Uint8Array).length < 400_000);
  assert.equal((await c.get("외국환거래규정"))!.body, body);
});
