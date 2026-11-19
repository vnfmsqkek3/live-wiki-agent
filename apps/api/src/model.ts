// 모델 호출 단일 모듈 (docs/03 5장 "모델 호출 모듈 단일화"). 모델 ID는 환경변수로만 받는다.
// 입력은 반드시 마스킹된 텍스트여야 한다 (호출자가 보장). 구조화 출력은 Converse tool-use 강제로 받는다.
import { BedrockRuntimeClient, ConverseCommand, InvokeModelCommand, type Message, type ToolInputSchema } from '@aws-sdk/client-bedrock-runtime';

let client: BedrockRuntimeClient | undefined;
const br = () => (client ??= new BedrockRuntimeClient({ region: process.env.AWS_REGION }));

export type ModelTier = 'HAIKU' | 'SONNET' | 'OPUS';

/** JSON 스키마를 만족하는 객체 1개를 받는다 */
// Claude 5.5 는 temperature 를 400으로 거부 (11/19 팀 계정 실측)
export async function structured<T>(tier: ModelTier, system: string, user: string, name: string, schema: Record<string, unknown>): Promise<{ value: T; model: string }> {
  const model = process.env[`MODEL_${tier}`];
  if (!model) throw new Error(`missing env MODEL_${tier}`);
  // Haiku 5.5·4.x 는 도구 강제 가능, Sonnet 5.5·Opus 5.5·Fable 은 400 → auto + 재요청 1번 (11/19 팀 계정 실측)
  const forced = !/sonnet-5-5|opus-5-5|fable-5/.test(model);
  const req = {
    modelId: model,
    system: [{ text: `${system}\n결과는 반드시 ${name} 도구로 제출한다.` }],
    messages: [{ role: 'user' as const, content: [{ text: user }] }] as Message[],
    inferenceConfig: { maxTokens: 4096 },
    toolConfig: { tools: [{ toolSpec: { name, description: '결과를 이 형식으로 제출', inputSchema: { json: schema } as ToolInputSchema.JsonMember } }], toolChoice: forced ? { tool: { name } } : { auto: {} } },
  };
  let r = await br().send(new ConverseCommand(req));
  let use = r.output?.message?.content?.find((c) => c.toolUse)?.toolUse;
  if (!use?.input && !forced && r.output?.message) {
    r = await br().send(new ConverseCommand({ ...req, messages: [...req.messages, r.output.message, { role: 'user', content: [{ text: `결과를 ${name} 도구로 제출하라.` }] }] }));
    use = r.output?.message?.content?.find((c) => c.toolUse)?.toolUse;
  }
  if (!use?.input) throw new Error('model returned no structured output'); // 빈 결과로 성공 처리 금지
  return { value: use.input as T, model };
}

/** 문장 임베딩 (Titan Text Embeddings v2, 1024차원, 정규화). 업무 분류 칸 유사도용. 입력은 마스킹된 텍스트 */
export async function embed(text: string): Promise<number[]> {
  const model = process.env.MODEL_EMBED;
  if (!model) throw new Error('missing env MODEL_EMBED');
  const r = await br().send(new InvokeModelCommand({ modelId: model, contentType: 'application/json', accept: 'application/json', body: JSON.stringify({ inputText: text.slice(0, 8000), dimensions: 1024, normalize: true }) }));
  const v = (JSON.parse(new TextDecoder().decode(r.body)) as { embedding?: number[] }).embedding;
  if (!v?.length) throw new Error('empty embedding');
  return v;
}
