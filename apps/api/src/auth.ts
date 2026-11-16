import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { ROLES, type Actor, type Role } from './contracts.ts';
import { ApiError } from './errors.ts';

export type VerifyToken = (token: string) => Promise<Actor>;

/** 사용자 식별은 검증된 JWT claims에서만 한다 (헤더·바디의 user id는 무시). */
export function cognitoVerifier(userPoolId: string, clientId: string): VerifyToken {
  const v = CognitoJwtVerifier.create({ userPoolId, clientId, tokenUse: 'access' }); // Runtime·Gateway가 access token만 통과 (interfaces 9장)
  return async (token) => {
    let p: Record<string, unknown>;
    try {
      p = (await v.verify(token)) as Record<string, unknown>;
    } catch {
      throw new ApiError('UNAUTHORIZED', 'invalid token');
    }
    return claimsToActor(p);
  };
}

export function claimsToActor(p: Record<string, unknown>): Actor {
  const raw = Array.isArray(p['cognito:groups']) ? (p['cognito:groups'] as unknown[]) : [];
  const groups = raw.filter((g): g is Role => (ROLES as readonly string[]).includes(g as string));
  if (typeof p.sub !== 'string') throw new ApiError('UNAUTHORIZED', 'missing sub');
  const d = p['dept'] ?? p['custom:dept']; // access token의 dept는 Pre Token Generation V2 트리거가 추가
  const dept = typeof d === 'string' ? d : undefined;
  return { sub: p.sub, groups: groups.length ? groups : ['USER'], dept };
}

export function hasRole(actor: Actor, allowed: readonly Role[]) {
  return actor.groups.some((g) => allowed.includes(g));
}

/** 문서 ACL: ALL, 사용자 그룹, `DEPT#{부서}` 중 하나와 일치해야 조회 가능 (interfaces.md v0.1, search Tool aclKeys와 동일) */
export function canRead(actor: Actor, acl: string[]) {
  return acl.includes('ALL') || acl.some((g) => (actor.groups as string[]).includes(g) || (!!actor.dept && g === `DEPT#${actor.dept}`));
}
