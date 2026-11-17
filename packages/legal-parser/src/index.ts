export { parseLaw } from "./parse.ts";
export { diffLaws, relPath } from "./diff.ts";
export { restoreCircled, ocrRows } from "./ocr-fix.ts";
export type { OcrBox } from "./ocr-fix.ts";
export type { ProvisionChange } from "./diff.ts";
export { docDates, primaryDate, titleCandidate, similarity, previousVersionCandidates, diffDocuments } from "./docmeta.ts";
export type { DocDate, DateKind, DocChange, VersionCandidate } from "./docmeta.ts";
