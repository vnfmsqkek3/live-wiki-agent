import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseLaw, diffLaws } from "./index.ts";
import { FIXTURE_ROOT, readFixture, readFixtureJson } from "./fixtures.ts";

interface Doc { document_id: string; file: string; law_id?: string; revision_id?: string; expected_changes?: string[] }
const manifest = readFixtureJson<{ documents: Doc[] }>("documents/manifest.json");
const registry = readFixtureJson<{ regulations: { fixture: string; content_hash: string; revision_id: string; key_values: Record<string, string> }[] }>("registry/registry.json");
const sha = (rel: string) => "sha256:" + createHash("sha256").update(readFileSync(FIXTURE_ROOT + rel)).digest("hex");
const F = (id: string) => manifest.documents.find((d) => d.document_id === id)!;
const parseDoc = (id: string) => { const d = F(id); return parseLaw(readFixture(d.file), { law_id: d.law_id!, law_name: "하나은행 기업여신 심사규정", revision_id: d.revision_id! }); };

test("데모 핵심 10건 존재 + 텍스트 문서 전부 SYNTHETIC 표시", () => {
  assert.equal(manifest.documents.length, 10);
  for (const d of manifest.documents) {
    const buf = readFileSync(FIXTURE_ROOT + d.file);
    assert.ok(buf.includes("SYNTHETIC"), `${d.document_id} SYNTHETIC 표시 없음`);
  }
});

test("Registry 기준본: F-001·F-002 해시 일치, F-003(위조)은 불일치", () => {
  for (const r of registry.regulations) assert.equal(sha(r.fixture), r.content_hash, `${r.fixture} 해시가 기준본과 다름 (fixture 수정 시 기준본도 의도적으로 갱신)`);
  assert.ok(!registry.regulations.some((r) => r.content_hash === sha("documents/F-003.txt")));
});

test("F-001·F-002 파싱 이슈 0건, Registry key_values가 실제 조문에 있음", () => {
  for (const id of ["F-001", "F-002"]) {
    const law = parseDoc(id);
    assert.deepEqual(law.issues, [], id);
    const reg = registry.regulations.find((r) => r.revision_id === F(id).revision_id)!;
    for (const [path, v] of Object.entries(reg.key_values)) {
      const p = law.provisions.find((x) => x.provision_id.endsWith("/" + path))!;
      assert.ok(p?.normalized_text.includes(v), `${id} ${path} ⊅ ${v}`);
    }
  }
});

test("F-001 → F-002 Diff가 정답 변경 조항과 일치, 수치 변화 추출", () => {
  const changes = diffLaws(parseDoc("F-001"), parseDoc("F-002"));
  const body = changes.filter((c) => !c.path.startsWith("SUPPLEMENTARY")).map((c) => c.path).sort();
  assert.deepEqual(body, [...F("F-002").expected_changes!].sort());
  const c12 = changes.find((c) => c.path === "ARTICLE:12/PARAGRAPH:1")!;
  assert.deepEqual([c12.numbers_changed.old, c12.numbers_changed.new], [["5억원"], ["3억원"]]);
  assert.equal(changes.find((c) => c.path === "ARTICLE:15/PARAGRAPH:2")!.kind, "DELETED");
});

test("데모 업로드 PDF: Registry pdf_content_hash와 일치, F-003(위조) PDF는 어떤 기준본과도 불일치", () => {
  const reg = { regulations: ["registry/registry.json", "registry/registry.golden.json"].flatMap((f) => readFixtureJson<{ regulations: { pdf_fixture?: string; pdf_content_hash?: string }[] }>(f).regulations) };
  const withPdf = reg.regulations.filter((r) => r.pdf_fixture);
  assert.equal(withPdf.length, 3 + 16); // 데모 F-000~002 + Golden 규정 16건
  for (const r of withPdf) assert.equal(sha(r.pdf_fixture!), r.pdf_content_hash, r.pdf_fixture!);
  const all = reg.regulations.flatMap((r) => [r.pdf_content_hash]);
  assert.ok(!all.includes(sha("documents/pdf/F-003.pdf")));
  for (const d of manifest.documents as (Doc & { upload_file?: string | null })[]) {
    if (d.upload_file) assert.match(d.upload_file, /\.(pdf|png)$/u, d.document_id);
  }
});

test("diffLaws: 띄어쓰기만 다른 조문은 개정 아님 (prod 11/18 '업종 집중도'↔'업종집중도')", () => {
  const meta = { law_id: "X", law_name: "x" };
  const a = parseLaw("제6조(확인) ① 다음을 확인한다.\n1. 동일인 합산 익스포저\n2. 업종 집중도", { ...meta, revision_id: "2026-11-01" });
  const b = parseLaw("제6조(확인) ① 다음을 확인한다.\n1. 동일인 합산 익스포저\n2. 업종집중도", { ...meta, revision_id: "2026-12-01" });
  assert.deepEqual(diffLaws(a, b), []);
  const c = parseLaw("제6조(확인) ① 다음을 확인한다.\n1. 동일인 합산 익스포저\n2. 업종 편중도", { ...meta, revision_id: "2026-12-01" });
  assert.deepEqual(diffLaws(a, c).map((x) => [x.path, x.kind]), [["ARTICLE:6/PARAGRAPH:1/ITEM:2", "MODIFIED"]]);
});
