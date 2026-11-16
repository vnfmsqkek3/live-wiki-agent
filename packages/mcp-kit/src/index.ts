// AgentCore Gateway Lambda Target 공통: Tool 이름 해석, 신원(actor) 추출, 오류 형식.
// Gateway는 Tool 인자를 event로, Tool 이름을 context.clientContext.custom.bedrockAgentCoreToolName("{target}___{tool}")으로 전달.
// 신원: Gateway REQUEST interceptor가 JWT를 재검증한 뒤 event.__actor = { sub, groups, dept? }를 주입한다 (interfaces.md 9장, dhxorb96 M0 확정).
// interceptor가 모델이 보낸 __actor를 덮어쓰므로 __actor만 신뢰하고, 그 밖의 신원 인자(user_id·actor·groups 등)는 무시한다.
import { detectPii, mask } from "@hanaeum/pii";
import { Role } from "@hanaeum/schemas";

export interface Actor { sub: string; groups: string[]; dept?: string }
export interface LambdaContext { clientContext?: { custom?: Record<string, unknown> } }
export type ToolHandler = (args: Record<string, unknown>, actor: Actor) => Promise<unknown>;

export class ToolError extends Error {
  readonly code: string;
  constructor(code: "ACCESS_DENIED" | "INVALID_ARGUMENT" | "NOT_FOUND" | "UNKNOWN_TOOL", message: string) { super(message); this.code = code; this.name = "ToolError"; }
}

/** 신원은 interceptor가 주입한 event.__actor에서만 읽는다 */
export function actorFrom(event: Record<string, unknown>): Actor {
  const raw = event["__actor"] as Partial<Actor> | string | undefined;
  let a: Partial<Actor> | undefined;
  try { a = typeof raw === "string" ? (JSON.parse(raw) as Partial<Actor>) : raw; } catch { a = undefined; }
  if (!a?.sub || !Array.isArray(a.groups)) throw new ToolError("ACCESS_DENIED", "검증된 사용자 컨텍스트 없음");
  return { sub: a.sub, groups: a.groups.filter((g) => Role.safeParse(g).success || g.startsWith("DEPT#")), dept: a.dept };
}

export const toolName = (ctx: LambdaContext): string => {
  const n = String(ctx.clientContext?.custom?.["bedrockAgentCoreToolName"] ?? "");
  return n.includes("___") ? n.split("___").pop()! : n;
};

/** 사용자 그룹 → 문서 acl_groups와 대조할 값. "ALL" + 역할 + DEPT#{부서} */
export const aclKeys = (a: Actor): string[] => ["ALL", ...a.groups, ...(a.dept ? [`DEPT#${a.dept}`] : [])];

/** 질의·인자의 개인 식별 정보 치환 (모델·임베딩 호출 전). 규칙은 단일 원본 @hanaeum/pii (dhxorb96):
 *  주민번호·전화·이메일·카드·계좌·고객번호 등 개인을 식별하는 값만. 이름·나이 등은 대상 아님 (사용자 결정 11/17) */
export const maskPii = (s: string): { text: string; masked: boolean } => {
  const spans = detectPii(s);
  return { text: spans.length ? mask(s, spans) : s, masked: spans.length > 0 };
};

export function makeHandler(tools: Record<string, ToolHandler>) {
  return async (event: Record<string, unknown>, ctx: LambdaContext) => {
    try {
      const name = toolName(ctx);
      const fn = tools[name];
      if (!fn) throw new ToolError("UNKNOWN_TOOL", name);
      const args = { ...(event ?? {}) };
      delete args["__actor"]; // Tool 로직에는 신원 인자를 넘기지 않음
      return await fn(args, actorFrom(event ?? {}));
    } catch (e) {
      if (e instanceof ToolError) return { error: { code: e.code, message: e.message } };
      throw e;
    }
  };
}

export const str = (args: Record<string, unknown>, k: string, required = true): string => {
  const v = args[k];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (required) throw new ToolError("INVALID_ARGUMENT", `${k} 필요`);
  return "";
};
export const asOfYmd = (args: Record<string, unknown>): number => {
  const v = str(args, "as_of", false);
  if (!v) return Number(new Date().toISOString().slice(0, 10).replaceAll("-", ""));
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(v)) throw new ToolError("INVALID_ARGUMENT", "as_of는 YYYY-MM-DD");
  return Number(v.replaceAll("-", ""));
};
