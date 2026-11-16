// 문서 처리 오케스트레이터 Runtime 진입점 (AgentCore Runtime HTTP 계약: GET /ping, POST /invocations, 8080).
// IAM 인증 Runtime. 호출자: type-detection(start), 승인 API(resume). 비동기: 즉시 202, 백그라운드 실행 중엔 /ping = HealthyBusy
import { createServer, type IncomingMessage } from 'node:http';
import { awsDeps } from './aws.ts';
import { ingestGraph, publishGraph, run, type StepInput } from './orchestrator.ts';

let busy = 0;
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 16_000) throw new Error('payload too large'); }
  return s ? JSON.parse(s) : {};
}
const ID = /^(wf|doc)_[0-9A-HJKMNP-TV-Z]{26}$/;

createServer(async (req, res) => {
  const send = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  try {
    if (req.method === 'GET' && req.url === '/ping') return send(200, { status: busy ? 'HealthyBusy' : 'Healthy', time_of_last_update: Math.floor(Date.now() / 1000) });
    if (req.method !== 'POST' || req.url !== '/invocations') return send(404, { error: 'not found' });
    const b = await readJson(req);
    const i = b.input as StepInput | undefined;
    if (!i || !ID.test(i.workflow_id) || !ID.test(i.doc_id)) return send(400, { error: 'input.workflow_id·doc_id 필요' });
    const graph = b.action === 'start' ? ingestGraph(awsDeps, i)
      : b.action === 'resume' && ['APPROVE', 'REJECT', 'REVALIDATE'].includes(String(b.decision)) ? publishGraph(awsDeps, i, b.decision as 'APPROVE')
      : undefined;
    if (!graph) return send(400, { error: 'action: start | resume(decision)' });
    busy++;
    void run(graph, awsDeps, i)
      .then((r) => console.log(JSON.stringify({ workflow_id: i.workflow_id, action: b.action, ...r })))
      .finally(() => { busy--; });
    return send(202, { accepted: true, workflow_id: i.workflow_id, action: b.action });
  } catch (e) {
    console.error(JSON.stringify({ err: (e as Error).name }));
    send(500, { error: 'internal error' });
  }
}).listen(Number(process.env.PORT ?? 8080));
