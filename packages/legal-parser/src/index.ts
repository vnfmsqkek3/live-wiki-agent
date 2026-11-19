export { parseLaw } from "./parse.ts";
/** 파싱 이슈 코드 → 사용자 안내 (SegmentBuild 승인 전 안내·GraphUpsert 게시 안내 공통) */
export const ISSUE_TEXT: Record<string, string> = {
  NUMBER_REGRESSION: "조·항·호 번호 순서가 맞지 않습니다(조문 누락 또는 번호 오류)",
  UNRESOLVED_REF: "다른 조문을 가리키는 인용을 찾지 못했습니다",
  REF_TO_DELETED: "삭제된 조문을 인용하고 있습니다",
  DUPLICATE_ID: "같은 번호의 조문이 두 번 나옵니다",
  ORPHAN_TEXT: "어느 조문에도 속하지 않는 문장이 있습니다",
  EMPTY_PROVISION: "본문이 비어 있는 조문이 있습니다",
};
export { diffLaws, relPath } from "./diff.ts";
export { restoreCircled, ocrRows, ocrRowsY } from "./ocr-fix.ts";
export type { OcrBox, CircledState } from "./ocr-fix.ts";
export type { ProvisionChange } from "./diff.ts";
export { docDates, primaryDate, titleCandidate, similarity, previousVersionCandidates, diffDocuments } from "./docmeta.ts";
export type { DocDate, DateKind, DocChange, VersionCandidate } from "./docmeta.ts";
