import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/", "**/dist/", "**/.next/", "**/.terraform/", "services/ocr/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // ponytail: JS 스크립트는 Node 전용이라 전역 목록(globals 패키지) 대신 no-undef 만 끈다 (TS 파일과 동일한 처리)
  { files: ["**/*.{js,mjs,cjs}"], rules: { "no-undef": "off" } },
);
