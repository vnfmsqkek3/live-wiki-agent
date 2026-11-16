// AgentCore Runtime 컨테이너 진입점 (HTTP 계약: GET /ping, POST /invocations, port 8080).
// Agent는 KB·DynamoDB를 직접 호출하지 않고 Gateway MCP Tool만 쓴다.
import { createServer, type IncomingMessage } from 'node:http';
import { Agent, BedrockModel, McpClient } from '@strands-agents/sdk';
import { GUIDE_SYSTEM, GuideDraft, MOCK_EVIDENCE, guide, type Evidence } from './guide.ts';

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 64_000) throw new Error('payload too large'); }
  return s ? JSON.parse(s) : {};
}

/** Gateway search Tool 호출. 사용자 JWT를 그대로 전달 → interceptor가 __actor 주입 → Tool이 ACL 강제 */
async function searchViaGateway(query: string, authorization: string): Promise<Evidence[]> {
  const client = new McpClient({ url: env('GATEWAY_URL'), headers: { authorization } });
  try {
    const name = process.env.SEARCH_TOOL ?? 'search___search_wiki';
    const tool = (await client.listTools()).find((t) => t.name === name);
    if (!tool) throw new Error(`tool not found: ${name}`);
    const r = (await client.callTool(tool, { query, top_k: 5 })) as { content?: { type: string; text?: string }[] };
    const text = r.content?.find((c) => c.type === 'text')?.text ?? '{}';
    return ((JSON.parse(text) as { items?: Evidence[] }).items ?? []);
  } finally {
    await client.disconnect();
  }
}

async function draftWithModel(prompt: string): Promise<GuideDraft> {
  const agent = new Agent({
    model: new BedrockModel({ region: env('AWS_REGION'), modelId: env('MODEL_SONNET'), temperature: 0, maxTokens: 2048 }),
    systemPrompt: GUIDE_SYSTEM,
    structuredOutputSchema: GuideDraft,
    printer: false,
  });
  const r = await agent.invoke(prompt);
  return r.structuredOutput as GuideDraft;
}

createServer(async (req, res) => {
  const send = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  try {
    if (req.method === 'GET' && req.url === '/ping') return send(200, { status: 'Healthy', time_of_last_update: Math.floor(Date.now() / 1000) });
    if (req.method === 'POST' && req.url === '/invocations') {
      const b = await readJson(req);
      if (typeof b.prompt !== 'string' || !b.prompt.trim() || b.prompt.length > 1000) return send(400, { error: 'prompt: 1~1000자' });
      const auth = req.headers['authorization'];
      const search = process.env.GATEWAY_URL
        ? (q: string) => { if (typeof auth !== 'string') throw new Error('no authorization'); return searchViaGateway(q, auth); }
        : async () => MOCK_EVIDENCE; // ponytail: Gateway search Tool(let522mj) 연동 전 mock
      return send(200, await guide(b.prompt, { search, draft: draftWithModel, model: env('MODEL_SONNET') }));
    }
    send(404, { error: 'not found' });
  } catch (e) {
    console.error(JSON.stringify({ err: (e as Error).name })); // 원문·토큰 미기록
    send(500, { error: 'internal error' });
  }
}).listen(Number(process.env.PORT ?? 8080));
