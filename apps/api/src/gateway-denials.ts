// Gateway 안에서 일어난 거부(AgentCore Policy)를 사용자 Gateway 로그에서 읽어 평가 화면 denials 로 (P1 데모 06, 인프라 로그 전달 11/20).
// 거부 이벤트(body.policy)에는 도구명이 없다 → 같은 trace_id 의 'Started processing request' 이벤트 requestBody 에서 도구·역할만 뽑는다.
// requestBody 에는 Tool 인자 원문과 __actor.sub 가 있다: 도구명·groups 외에는 읽지도 내보내지도 않는다.
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';

export interface GatewayDenial { at: string; role: string; tool: string; reason: string; trace_id: string }

/** 'Policy evaluation denied request' 이벤트 → 시각·사유·trace_id */
export function parseDenial(message: string): Omit<GatewayDenial, 'role' | 'tool'> | undefined {
  try {
    const m = JSON.parse(message) as { event_timestamp?: number; trace_id?: string; body?: { policy?: { decision?: string; reason?: string } } };
    if (m.body?.policy?.decision !== 'DENY' || !m.trace_id) return undefined;
    // 정책 이름 끝의 생성 접미사(-lgof7yte8a)는 사람에게 의미가 없다
    const reason = (m.body.policy.reason ?? 'Policy 거부').replace(/-[a-z0-9]{10}\b/g, '').slice(0, 200);
    return { at: new Date(m.event_timestamp ?? 0).toISOString(), reason, trace_id: m.trace_id };
  } catch { return undefined; }
}

/** 'Started processing request' 이벤트 requestBody(JSON 아님, k=v 문자열) → 도구명·역할. 인자·sub 는 버림 */
export function parseRequest(message: string): { tool: string; role: string } {
  try {
    const body = String((JSON.parse(message) as { body?: { requestBody?: unknown } }).body?.requestBody ?? '');
    const tool = /params=\{name=([\w-]+___[\w-]+)/.exec(body)?.[1] ?? '';
    const groups = /groups=\[([A-Z_, ]*)\]/.exec(body)?.[1] ?? '';
    return { tool, role: groups.split(',').map((g) => g.trim()).filter(Boolean).join(',') };
  } catch { return { tool: '', role: '' }; }
}

/** ponytail: 거부 최대 20건, 건마다 trace_id 로 요청 이벤트 1회 조회. 거부가 많아지면 Logs Insights 한 번으로 */
export function gatewayDenialsReader(logGroupName: string, client = new CloudWatchLogsClient({})) {
  const filter = async (filterPattern: string, startTime: number, limit: number) =>
    (await client.send(new FilterLogEventsCommand({ logGroupName, filterPattern, startTime, limit }))).events ?? [];
  return async (since: string): Promise<GatewayDenial[]> => {
    const start = Date.parse(since);
    const denials = (await filter('"Policy evaluation denied request"', start, 20)).map((e) => parseDenial(e.message ?? '')).filter((d) => !!d);
    return Promise.all(denials.map(async (d) => {
      const [req] = await filter(`{ $.trace_id = "${d.trace_id.replace(/[^0-9a-f]/g, '')}" && $.body.log = "Started processing request" }`, start, 1).catch(() => []);
      return { ...d, ...(req ? parseRequest(req.message ?? '') : { tool: '', role: '' }) };
    }));
  };
}
