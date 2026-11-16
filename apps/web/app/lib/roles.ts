// 그룹별 화면 (서버 권한과 같은 기준: apps/api app.ts need()). 화면 숨김은 편의일 뿐, 권한은 서버가 강제한다 (01 §3.1).
import type { Role } from './api';

export const ROLE_NAME: Record<Role, string> = { USER: '직원', AUTHOR: '작성자', REG_APPROVER: '규정 승인자', SECURITY_REVIEWER: '보안 검토자', PLATFORM_OPERATOR: '운영자' };
export const APPROVERS: Role[] = ['REG_APPROVER', 'SECURITY_REVIEWER'];

/** 경로별 허용 그룹. 없으면 로그인한 모두 */
export const PAGE_ROLES: Record<string, Role[]> = {
  '/upload': ['AUTHOR'],
  '/review': ['AUTHOR', ...APPROVERS],
  '/admin': APPROVERS,
};

export const can = (groups: Role[] | undefined, path: string) => {
  const need = Object.entries(PAGE_ROLES).find(([p]) => path === p || path.startsWith(`${p}/`))?.[1];
  return !need || (groups ?? []).some((g) => need.includes(g));
};
