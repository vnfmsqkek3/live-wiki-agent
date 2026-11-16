// 로컬 KB 에뮬레이터: RetrievalFilter를 그대로 평가하고 문자 bigram으로 점수. 테스트·오프라인 평가 전용 (실제 KB 품질과 다름)
import type { RetrievalFilter } from "@aws-sdk/client-bedrock-agent-runtime";
import type { DocState, DocStates, Hit, Retriever } from "./search.ts";

type Meta = Record<string, unknown>;
export function evalFilter(f: RetrievalFilter, m: Meta): boolean {
  const f2 = f as unknown as Record<string, { key: string; value: unknown } | RetrievalFilter[]>;
  const [op, arg] = Object.entries(f2)[0]!;
  if (op === "andAll") return (arg as RetrievalFilter[]).every((x) => evalFilter(x, m));
  if (op === "orAll") return (arg as RetrievalFilter[]).some((x) => evalFilter(x, m));
  const { key, value } = arg as { key: string; value: unknown };
  const v = m[key];
  switch (op) {
    case "equals": return v === value;
    case "notEquals": return v !== value;
    case "lessThanOrEquals": return Number(v) <= Number(value);
    case "greaterThanOrEquals": return Number(v) >= Number(value);
    case "in": return (value as unknown[]).includes(v);
    case "listContains": return Array.isArray(v) && v.includes(value);
    default: throw new Error(`미지원 필터 ${op}`);
  }
}

const bigrams = (s: string) => {
  const t = s.replace(/[\s\p{P}]/gu, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
};

export class MemoryRetriever implements Retriever {
  readonly chunks: { text: string; metadata: Meta }[] = [];
  lastFilter: RetrievalFilter | undefined;
  lastQuery = "";
  add(text: string, metadata: Meta) { this.chunks.push({ text, metadata }); }
  async retrieve(query: string, filter?: RetrievalFilter): Promise<Hit[]> {
    this.lastFilter = filter;
    this.lastQuery = query;
    const q = bigrams(query);
    return this.chunks
      .filter((c) => !filter || evalFilter(filter, c.metadata))
      .map((c) => { const b = bigrams(c.text); let n = 0; for (const x of q) if (b.has(x)) n++; return { text: c.text, metadata: c.metadata, score: q.size ? n / q.size : 0 }; })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 15);
  }
}

export class MemoryDocStates implements DocStates {
  readonly docs = new Map<string, DocState>();
  async get(ids: string[]) { return new Map(ids.filter((i) => this.docs.has(i)).map((i) => [i, this.docs.get(i)!])); }
}
