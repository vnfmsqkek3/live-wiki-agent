// 모델 호출 단일 모듈 (docs/03 5장 "모델 호출 모듈 단일화"). 모델 ID는 환경변수로만 받는다.
// 입력은 반드시 마스킹된 텍스트여야 한다 (호출자가 보장). 구조화 출력은 Converse tool-use 강제로 받는다.
import { BedrockRuntimeClient, ConverseCommand, InvokeModelCommand, type ToolInputSchema } from '@aws-sdk/client-bedrock-runtime';

let client: BedrockRuntimeClient | undefined;
const br = () => (client ??= new BedrockRuntimeClient({ region: process.env.AWS_REGION }));

export type ModelTier = 'HAIKU' | 'SONNET' | 'OPUS';

/** JSON 스키마를 만족하는 객체 1개를 받는다. temperature 0 */
export async function structured<T>(tier: ModelTier, system: string, user: string, name: string, schema: Record<string, unknown>): Promise<{ value: T; model: string }> {
  const model = process.env[`MODEL_${tier}`];
  if (!model) throw new Error(`missing env MODEL_${tier}`);
  const r = await br().send(new ConverseCommand({
    modelId: model,
    system: [{ text: system }],
    messages: [{ role: 'user', content: [{ text: user }] }],
    inferenceConfig: { temperature: 0, maxTokens: 4096 },
    toolConfig: { tools: [{ toolSpec: { name, description: '결과를 이 형식으로 제출', inputSchema: { json: schema } as ToolInputSchema.JsonMember } }], toolChoice: { tool: { name } } },
  }));
  const use = r.output?.message?.content?.find((c) => c.toolUse)?.toolUse;
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
