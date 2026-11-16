export { parseLaw, normalizeText, circledToInt, PARSER_VERSION } from "./parse.ts";
export type { LawMeta } from "./parse.ts";
export { extractReferences, resolveReferences } from "./reference.ts";
export type { ExternalLawIndex } from "./reference.ts";
export { diffLaws } from "./diff.ts";
export type { ProvisionChange } from "./diff.ts";
