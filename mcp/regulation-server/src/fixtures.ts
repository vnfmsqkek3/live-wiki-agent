// tests/fixtures(Registry 기준본 + 합성 규정)로 MemoryClauseStore 구성. 테스트·로컬 데모·평가용
import { readFileSync } from "node:fs";
import { parseLaw } from "@hanaeum/legal-parser";
import { MemoryClauseStore } from "./store.ts";

const ROOT = new URL("../../../tests/fixtures/", import.meta.url);
interface RegEntry { registry_doc_no: string; law_id: string; law_name: string; revision_id: string; effective_from: number; effective_to: number; content_hash: string; pdf_content_hash?: string; fixture: string }

export function fixtureClauseStore(): MemoryClauseStore {
  const store = new MemoryClauseStore();
  const load = (f: string) => (JSON.parse(readFileSync(new URL(f, ROOT), "utf8")) as { regulations: RegEntry[] }).regulations;
  for (const r of [...load("registry/registry.json"), ...load("registry/registry.golden.json")]) {
    const law = parseLaw(readFileSync(new URL(r.fixture, ROOT), "utf8"), { law_id: r.law_id, law_name: r.law_name, revision_id: r.revision_id, effective_from: r.effective_from });
    store.put({
      law_id: r.law_id, law_name: r.law_name, revision_id: r.revision_id, registry_doc_no: r.registry_doc_no,
      effective_from: r.effective_from, effective_to: r.effective_to, authority_status: "VERIFIED",
      doc_id: r.fixture.replace(/^.*\/|\.\w+$/gu, ""), content_hash: r.content_hash, ...(r.pdf_content_hash ? { pdf_content_hash: r.pdf_content_hash } : {}), acl_groups: ["ALL"], parse_ok: law.issues.length === 0,
    }, law);
  }
  // L-001: 엣지 케이스 법령 (의도적 이슈 포함 → parse_ok=false 이므로 부재 판정 금지 대상)
  const l = parseLaw(readFileSync(new URL("legal/source/L-001.txt", ROOT), "utf8"), { law_id: "SYN-VLOAN-001", law_name: "가상여신거래법", revision_id: "2026-11-01" });
  store.put({ law_id: "SYN-VLOAN-001", law_name: "가상여신거래법", revision_id: "2026-11-01", effective_from: 20261101, effective_to: 99991231, authority_status: "VERIFIED", doc_id: "L-001", content_hash: "", acl_groups: ["ALL"], parse_ok: l.issues.length === 0 }, l);
  return store;
}
