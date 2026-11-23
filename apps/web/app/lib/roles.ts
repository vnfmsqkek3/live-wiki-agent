// 계정 종류는 2가지 (사용자 결정 11/17): 관리자 / 사용자. 그룹(Cognito)은 그대로 두고 화면에서만 묶는다.
// 화면 숨김은 편의일 뿐, 권한은 서버가 그룹으로 강제한다 (01 §3.1). 자기 문서 승인 금지도 서버 규칙.
import type { Role } from './api';

/** 화면에 보이는 역할 이름 (엔드유저 11/20: 'AUTHOR'·'REG_APPROVER' 영문 노출) */
export const ROLE_NAME: Record<Role, string> = { USER: '일반 사용자', AUTHOR: '작성자', REG_APPROVER: '규정 결재자', SECURITY_REVIEWER: '보안 검토자', PLATFORM_OPERATOR: '운영자' };
export const roleText = (s: string) => s.replace(/\b(USER|AUTHOR|REG_APPROVER|SECURITY_REVIEWER|PLATFORM_OPERATOR)\b/g, (r) => ROLE_NAME[r as Role]);

/** 이 그룹 중 하나라도 있으면 관리자 */
export const ADMIN_GROUPS: Role[] = ['REG_APPROVER', 'SECURITY_REVIEWER', 'PLATFORM_OPERATOR'];
export const isAdmin = (groups: Role[] | undefined) => (groups ?? []).some((g) => ADMIN_GROUPS.includes(g));
export const accountLabel = (groups: Role[] | undefined) => (isAdmin(groups) ? '관리자' : '사용자');

/** 경로별 허용: admin = 관리자만. 등록·고치기는 로그인한 누구나 (사용자 결정 11/17 규칙 1) */
const PAGE_RULES: { path: string; ok: (g: Role[]) => boolean; label: string }[] = [
  { path: '/admin', ok: isAdmin, label: '관리자' },
];
const rule = (path: string) => PAGE_RULES.find((r) => path === r.path || path.startsWith(`${r.path}/`));
export const can = (groups: Role[] | undefined, path: string) => { const r = rule(path); return !r || r.ok(groups ?? []); };
export const needLabel = (path: string) => rule(path)?.label ?? '';
