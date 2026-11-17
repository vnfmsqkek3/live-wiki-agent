// 검색 질의 재구성 (요청기록 20261117-1910, 사용자 결정 "권고를 적용해줘").
// 문장형 질의("…관련된 문서들을 찾아줘")는 Rerank 점수가 게이트(0.30) 아래로 떨어진다 → 규칙으로 군더더기를 지우고,
// Haiku가 같은 뜻의 핵심 질의(core)와 다른 표현(alternates ≤2)을 만든다. 입력은 PII 마스킹된 질의만.
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

export interface Rewritten { core: string; alternates: string[] }
export interface Rewriter { rewrite(maskedQuery: string): Promise<Rewritten> }

// 끝에서부터 반복 제거: 요청 어미 → 질문 어미 → "관련된 문서들을" → "에 대한".
// 조사 "이·가"는 명사 끝 글자와 구분이 안 돼("평가", "단가") 지우지 않는다
const TAIL = [
  /\s*(?:좀\s*)?(?:찾아|알려|보여|검색해|정리해|설명해)\s*(?:줘요?|주세요|줄래요?|주실래요|주시겠어요|봐)?\s*[.?!~]*$/u,
  /(?:은|는|을|를)?\s+(?:어떻게|뭐|무엇|어디)(?:\s*(?:해야|하면|되))?\s*(?:하나요|하죠|해요|돼요|되나요|되죠|인가요|있나요|야|지|요)?\s*[.?!~]*$/u,
  // "관련"·"문서" 앞에는 공백 필수, 조사 "과"는 명사 끝 글자와 구분이 안 돼("성과") 떨어져 있을 때만 (붙여 쓴 "한도초과"·"공문서"·"참고자료"의 꼬리를 자르지 않게, PR #24 리뷰)
  /(?:와|에|\s+과)?\s+관련(?:된|한|해서)?(?:\s+(?:문서|자료|내용|규정))?\s*(?:들)?\s*(?:을|를|이|가)?$/u,
  /\s+(?:문서|자료)\s*(?:들)?\s*(?:을|를)?$/u,
  /\s*에\s*(?:대한|대해서?|관한)$/u,
];
/** 규칙만으로 정리. 다 지워지면 원문 */
export function cleanQuery(q: string): string {
  let s = q.trim();
  for (let changed = true; changed;) {
    changed = false;
    for (const r of TAIL) { const t = s.replace(r, "").trim(); if (t !== s && t) { s = t; changed = true; } }
  }
  return s || q.trim();
}

const SYSTEM = `너는 은행 내부 위키 검색 질의를 다듬는다. 입력 질의의 뜻을 바꾸지 말고 검색에 맞는 짧은 명사구로 바꿔 report_query로만 답한다.
- core: 질의의 핵심 주제를 담은 1~6단어 명사구. 요청 어미·군더더기(찾아줘, 알려줘, 관련, 문서, 자료, 규정, 어떻게)는 뺀다. 예) "개인정보 관련된 문서들을 찾아줘" → "개인정보".
- alternates: 같은 뜻을 다른 단어 경계나 동의어로 쓴 질의 0~2개. 예) "처리방법" → "처리 절차", "처리 기준".
- 새 주제·기관명·법령명·조문 번호를 지어내지 않는다. 입력에 없는 고유명사를 넣지 않는다.
- [전화번호] 같은 가림 표시는 그대로 둔다.`;
const TOOL = {
  name: "report_query",
  description: "다듬은 검색 질의",
  inputSchema: { type: "object", properties: { core: { type: "string" }, alternates: { type: "array", items: { type: "string" }, maxItems: 2 } }, required: ["core", "alternates"] },
};

const MAX_LEN = 100;
const norm = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/gu, " ").trim().slice(0, MAX_LEN) : "");
/** 원문과 2글자 이상 겹치는 낱말이 있는지 (주제 이탈 차단. "처리 절차"는 "처리방법"과 "처리"가 겹침) */
const overlaps = (cand: string, src: string) => cand.split(" ").some((w) => w.length >= 2 && src.includes(w));
/** 모델 출력 검증: core 없거나 원문과 겹치는 낱말이 없으면 규칙 결과. alternates도 원문과 겹치는 것만, 중복 제거 후 2개까지 */
export function sanitize(out: unknown, fallback: string, source = fallback): Rewritten {
  const o = (out ?? {}) as { core?: unknown; alternates?: unknown };
  const c0 = norm(o.core);
  const core = c0 && overlaps(c0, source) ? c0 : fallback;
  const alts = Array.isArray(o.alternates) ? o.alternates.map(norm).filter((a) => a && overlaps(a, source)) : [];
  return { core, alternates: [...new Set(alts)].filter((a) => a !== core).slice(0, 2) };
}

export class BedrockRewriter implements Rewriter {
  private readonly c: BedrockRuntimeClient;
  private readonly model: string;
  // ponytail: Lambda 인스턴스 메모리 캐시(최근 500개, FIFO). 인스턴스 간 공유가 필요해지면 DynamoDB TTL
  private readonly cache = new Map<string, Rewritten>();
  /** 느린 모델 응답이 검색 전체를 붙잡지 않게 (넘으면 규칙만) */
  static readonly TIMEOUT_MS = 2000;
  constructor(model: string, c = new BedrockRuntimeClient({ maxAttempts: 1 })) { this.model = model; this.c = c; }
  async rewrite(masked: string): Promise<Rewritten> {
    const base = cleanQuery(masked);
    const hit = this.cache.get(masked);
    if (hit) return structuredClone(hit); // 호출자가 응답을 고쳐도 캐시는 그대로
    let r: Rewritten;
    try {
      const res = await this.c.send(new ConverseCommand({
        modelId: this.model,
        system: [{ text: SYSTEM }],
        // 질의 안의 <, >는 바꿔 태그를 닫고 지시를 넣지 못하게
        messages: [{ role: "user", content: [{ text: `<query>${masked.slice(0, 500).replace(/[<>]/gu, " ")}</query>` }] }],
        toolConfig: { tools: [{ toolSpec: { name: TOOL.name, description: TOOL.description, inputSchema: { json: TOOL.inputSchema as never } } }], toolChoice: { tool: { name: TOOL.name } } },
        inferenceConfig: { maxTokens: 200, temperature: 0 },
      }), { abortSignal: AbortSignal.timeout(BedrockRewriter.TIMEOUT_MS) });
      r = sanitize(res.output?.message?.content?.find((x) => x.toolUse)?.toolUse?.input, base, masked);
    } catch (e) {
      // 재구성 실패는 검색 실패가 아니다: 규칙 결과로 계속. 질의는 로그에 남기지 않는다
      console.warn(JSON.stringify({ msg: "질의 재구성 실패 → 규칙만", error: (e as Error).name }));
      return { core: base, alternates: [] };
    }
    if (this.cache.size >= 500) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(masked, r);
    return structuredClone(r);
  }
}
