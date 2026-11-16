// AgentCore Memory (사용자 결정 11/16, let522mj 요청 2113). 사용자 Agent(가이드·검색 대화)만 쓴다.
// - 단기: 대화 이벤트 (actorId = Cognito sub, sessionId = 화면 대화 ID). 장기: summary 전략, 네임스페이스 /users/{actorId}/
// - 저장은 마스킹된 텍스트만. 꺼낸 내용은 질문 이해에만 쓰고 근거로 인용하지 않는다 (인용은 이번 검색 결과만 → Tool 재검증 보장)
import {
  BedrockAgentCoreClient, CreateEventCommand, DeleteEventCommand, DeleteMemoryRecordCommand, ListEventsCommand, ListMemoryRecordsCommand, ListSessionsCommand,
  RetrieveMemoryRecordsCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { detectPii, mask } from '../../apps/api/src/steps/pii-detect.ts';

export interface Turn { role: 'USER' | 'ASSISTANT'; text: string }

export interface ConversationMemory {
  /** 이 대화의 최근 턴 (오래된 → 최신) */
  history(actorId: string, sessionId: string, limit?: number): Promise<Turn[]>;
  /** 장기 요약 (사용자 범위만) */
  summaries(actorId: string, query: string, topK?: number): Promise<string[]>;
  /** 저장 전 PII를 다시 가린다 (호출자가 마스킹했더라도 이중 방어) */
  save(actorId: string, sessionId: string, turns: Turn[]): Promise<void>;
  /** 사용자 단위 삭제: 모든 세션 이벤트 + 장기 요약 레코드(/users/{actorId}/). 삭제 건수 */
  deleteActor(actorId: string): Promise<number>;
}

const safe = (t: string) => mask(t, detectPii(t)).slice(0, 4000);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/; // actorId·sessionId 형식 (네임스페이스 주입 방지)

export function agentCoreMemory(memoryId: string, region: string, client = new BedrockAgentCoreClient({ region })): ConversationMemory {
  const ids = (a: string, s?: string) => {
    if (!SAFE_ID.test(a) || (s !== undefined && !SAFE_ID.test(s))) throw new Error('invalid memory id');
  };
  return {
    async history(actorId, sessionId, limit = 6) {
      ids(actorId, sessionId);
      const r = await client.send(new ListEventsCommand({ memoryId, actorId, sessionId, includePayloads: true, maxResults: 50 }));
      const turns = (r.events ?? [])
        .sort((a, b) => (a.eventTimestamp?.getTime() ?? 0) - (b.eventTimestamp?.getTime() ?? 0))
        .flatMap((e) => (e.payload ?? []).map((p) => p.conversational).filter((c) => c?.content?.text))
        .map((c) => ({ role: c!.role === 'ASSISTANT' ? 'ASSISTANT' : 'USER', text: c!.content!.text! }) as Turn);
      return turns.slice(-limit);
    },
    async summaries(actorId, query, topK = 3) {
      ids(actorId);
      const r = await client.send(new RetrieveMemoryRecordsCommand({ memoryId, namespace: `/users/${actorId}/`, searchCriteria: { searchQuery: safe(query).slice(0, 500), topK } }));
      return (r.memoryRecordSummaries ?? []).map((m) => (m.content as { text?: string } | undefined)?.text ?? '').filter(Boolean);
    },
    async save(actorId, sessionId, turns) {
      ids(actorId, sessionId);
      await client.send(new CreateEventCommand({
        memoryId, actorId, sessionId, eventTimestamp: new Date(),
        payload: turns.map((t) => ({ conversational: { role: t.role, content: { text: safe(t.text) } } })),
      }));
    },
    async deleteActor(actorId) {
      ids(actorId);
      let n = 0;
      // 개인정보 삭제는 빠짐없이: 세션·이벤트 모두 페이지 끝까지
      let st: string | undefined;
      do {
        const ss = await client.send(new ListSessionsCommand({ memoryId, actorId, maxResults: 100, nextToken: st }));
        for (const s of ss.sessionSummaries ?? []) {
          let et: string | undefined;
          do {
            const ev = await client.send(new ListEventsCommand({ memoryId, actorId, sessionId: s.sessionId!, maxResults: 100, nextToken: et }));
            for (const e of ev.events ?? []) { await client.send(new DeleteEventCommand({ memoryId, actorId, sessionId: s.sessionId!, eventId: e.eventId! })); n++; }
            et = ev.nextToken;
          } while (et);
        }
        st = ss.nextToken;
      } while (st);
      // 장기 요약도 지워야 개인정보 삭제가 완전하다 (yoyo0704 지적). 네임스페이스는 이 사용자 것만
      let nextToken: string | undefined;
      do {
        const r = await client.send(new ListMemoryRecordsCommand({ memoryId, namespace: `/users/${actorId}/`, maxResults: 100, nextToken }));
        for (const m of r.memoryRecordSummaries ?? []) { await client.send(new DeleteMemoryRecordCommand({ memoryId, memoryRecordId: m.memoryRecordId! })); n++; }
        nextToken = r.nextToken;
      } while (nextToken);
      return n;
    },
  };
}
