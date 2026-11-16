// AgentCore Gateway Lambda Target 공통: Tool 이름 해석, 신원(actor) 추출, 오류 형식.
// [확인 필요] Gateway는 Tool 인자를 event로, Tool 이름을 context.clientContext.custom.bedrockAgentCoreToolName("{target}___{tool}")으로 전달.
// 신원 전달 방식은 interfaces.md 9장(dhxorb96, M0 실험)으로 확정 예정. 클라이언트(모델)가 보낸 인자 속 사용자 정보는 절대 쓰지 않는다.
import { Role } from "@hanaeum/schemas";

export interface Actor { sub: string; groups: string[]; dept?: string }
export interface LambdaContext { clientContext?: { custom?: Record<string, unknown> } }
export type ToolHandler = (args: Record<string, unknown>, actor: Actor) => Promise<unknown>;

export class ToolError extends Error {
  readonly code: string;
  constructor(code: "ACCESS_DENIED" | "INVALID_ARGUMENT" | "NOT_FOUND" | "UNKNOWN_TOOL", message: string) { super(message); this.code = code; this.name = "ToolError"; }
}

/** 신원은 Gateway가 넣은 컨텍스트에서만 읽는다 (event 인자 무시) */
export function actorFrom(ctx: LambdaContext): Actor {
  const c = ctx.clientContext?.custom ?? {};
  const raw = (c["hanaeumActor"] ?? c["actor"]) as Partial<Actor> | string | undefined;
  const a = typeof raw === "string" ? (JSON.parse(raw) as Partial<Actor>) : raw;
  if (!a?.sub || !Array.isArray(a.groups)) throw new ToolError("ACCESS_DENIED", "검증된 사용자 컨텍스트 없음");
  return { sub: a.sub, groups: a.groups.filter((g) => Role.safeParse(g).success || g.startsWith("DEPT#")), dept: a.dept };
}

export const toolName = (ctx: LambdaContext): string => {
  const n = String(ctx.clientContext?.custom?.["bedrockAgentCoreToolName"] ?? "");
  return n.includes("___") ? n.split("___").pop()! : n;
};

/** 사용자 그룹 → 문서 acl_groups와 대조할 값. "ALL" + 역할 + DEPT#{부서} */
export const aclKeys = (a: Actor): string[] => ["ALL", ...a.groups, ...(a.dept ? [`DEPT#${a.dept}`] : [])];

/** 질의·인자의 명백한 PII 패턴 치환 (모델·임베딩 호출 전 최소 방어. 정밀 검사는 privacy-server) */
const PII: [RegExp, string][] = [
  [/\d{6}\s*-\s*[1-4]\d{6}/gu, "[주민번호]"],
  [/01[016789]-?\d{3,4}-?\d{4}/gu, "[전화번호]"],
  [/\d{3,6}-\d{2,6}-\d{2,6}(?:-\d{1,3})?/gu, "[계좌번호]"],
  [/[\w.+-]+@[\w-]+\.[\w.]+/gu, "[이메일]"],
];
export const maskPii = (s: string): { text: string; masked: boolean } => {
  let t = s;
  for (const [re, rep] of PII) t = t.replace(re, rep);
  return { text: t, masked: t !== s };
};

export function makeHandler(tools: Record<string, ToolHandler>) {
  return async (event: Record<string, unknown>, ctx: LambdaContext) => {
    try {
      const name = toolName(ctx);
      const fn = tools[name];
      if (!fn) throw new ToolError("UNKNOWN_TOOL", name);
      return await fn(event ?? {}, actorFrom(ctx));
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
