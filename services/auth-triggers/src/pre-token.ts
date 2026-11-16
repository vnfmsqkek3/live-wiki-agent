// Cognito Pre Token Generation V2: access token 에 dept claim 을 넣는다.
// Runtime·Gateway·API 는 access token 만 받으므로 ABAC(부서) 판단에 필요 (dhxorb96 요청 11/16, interfaces.md 9장).
// groups 는 Cognito 가 cognito:groups 로 이미 넣는다.
export type PreTokenEvent = {
  request: { userAttributes: Record<string, string> };
  response: Record<string, unknown>;
};

export const handler = async (event: PreTokenEvent) => {
  const dept = event.request.userAttributes["custom:dept"] ?? "";
  const claims = { dept };
  event.response = {
    claimsAndScopeOverrideDetails: {
      accessTokenGeneration: { claimsToAddOrOverride: claims },
      idTokenGeneration: { claimsToAddOrOverride: claims },
    },
  };
  return event;
};
