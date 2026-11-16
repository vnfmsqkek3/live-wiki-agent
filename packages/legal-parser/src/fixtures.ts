// tests/fixtures/legal 접근 헬퍼 (테스트·평가 공용)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FIXTURE_ROOT = fileURLToPath(new URL("../../../tests/fixtures/", import.meta.url));
export const readFixture = (rel: string): string => readFileSync(FIXTURE_ROOT + rel, "utf8");
export const readFixtureJson = <T = unknown>(rel: string): T => JSON.parse(readFixture(rel)) as T;
