// 도구 하나로 구조화 결과를 받는 Converse 호출 (11/19 팀 계정 실측).
// Haiku 5.5·4.x 는 도구 강제(toolChoice tool)를 받지만 Sonnet 5.5·Opus 5.5·Fable 은 400 → auto 로 보내고, 도구 답이 없으면 한 번 더 요청한다.
import { ConverseCommand, type ConverseCommandInput, type ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";

export const canForceTool = (model: string) => !/sonnet-5-5|opus-5-5|fable-5/.test(model);

type Sender = { send(c: ConverseCommand): Promise<ConverseCommandOutput> };
const pick = (r: ConverseCommandOutput) => r.output?.message?.content?.find((c) => c.toolUse)?.toolUse?.input;

export async function converseTool(client: Sender, input: ConverseCommandInput, name: string): Promise<unknown> {
  const forced = canForceTool(String(input.modelId));
  const req: ConverseCommandInput = { ...input, toolConfig: { ...input.toolConfig!, toolChoice: forced ? { tool: { name } } : { auto: {} } } };
  const r = await client.send(new ConverseCommand(req));
  const out = pick(r);
  const msg = r.output?.message;
  if (out !== undefined || forced || !msg) return out;
  // ponytail: 재시도 1번. 그래도 글로만 답하면 호출한 쪽이 빈 결과로 처리(EmptySummary 등)
  return pick(await client.send(new ConverseCommand({ ...req, messages: [...(req.messages ?? []), msg, { role: "user", content: [{ text: `결과를 ${name} 도구로 제출하라.` }] }] })));
}
