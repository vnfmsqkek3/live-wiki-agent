// 서버·AI 문구 표시용: 내부 코드·조문 경로·역할 코드·제목 기호를 읽는 말로 (가이드·결재함·검색 공용)
import { roleText } from './roles';

// 가이드 문장 표시용 (엔드유저 11/20): '**굵게**'는 굵게, 내부 코드·조문 경로는 읽는 말로. 원문 근거는 바꾸지 않는다
const CODE: Record<string, string> = { REVIEW_REQUIRED: '재검토 중', NOT_FOUND_VERIFIED: '검증된 문서에서 찾지 못함', SUPERSEDED: '개정 전 판', MODIFIED: '개정', ADDED: '신설', DELETED: '삭제', CURRENT: '현행', VERIFIED: '검증됨', UNVERIFIED: '미검증' };
const UNIT: Record<string, string> = { ARTICLE: '조', PARAGRAPH: '항', ITEM: '호', SUBITEM: '목' };
export const readable = (s: string) => roleText(s.replace(/\s*\((USER|AUTHOR|REG_APPROVER|SECURITY_REVIEWER|PLATFORM_OPERATOR)\)/g, ''))
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/[\w-]+@[\d-]+\//g, '')
  .replace(/ARTICLE:[\w-]+(?:\/(?:PARAGRAPH|ITEM|SUBITEM):[\w-]+)*/g, (p) => p.split('/').map((x) => { const [k, v] = x.split(':'); return `제${v}${UNIT[k!]}`; }).join(''))
  .replace(/\b[A-Z][A-Z_]{4,}\b/g, (c) => CODE[c] ?? c);
