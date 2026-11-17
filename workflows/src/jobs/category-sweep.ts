// 업무 분류 주기 정리 (사용자 결정 11/17 "A: 완전 자동", Owner yoyo0704, 계약 interfaces.md 10.1). 매일 1회 (Scheduler).
// ① 임베딩이 없는 칸 채우기(이름+설명 → Titan v2 1024) ② 같은 부모 아래 유사 칸 병합(코사인 ≥ MERGE_SIM: 문서 적은 칸 → 많은 칸, SEED 칸은 남김)
// ③ 문서 0건이고 만든 지 EMPTY_DAYS 넘은 AI 칸 정리(부모로 merged_into). 모든 변경은 category_events 에 남긴다(원문 없음).
// ponytail: '기타' 문서를 새 칸으로 옮기는 일은 Classify 배정 함수(dhxorb96)가 나오면 재분류 보충과 함께 붙인다
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { db, type Query } from "@hanaeum/db";

export const MERGE_SIM = 0.9;
export const EMPTY_DAYS = 7;

export type Cat = { category_id: string; parent_id: string | null; name: string; description: string; origin: string; doc_count: number };
export type Deps = {
  q: Query;
  tx: <T>(fn: (q: Query) => Promise<T>) => Promise<T>;
  embed: (text: string) => Promise<number[]>;
};

const vec = (v: number[]) => `[${v.map((x) => x.toFixed(6)).join(",")}]`;

/** 병합 방향: SEED 칸을 남기고, 둘 다 같은 출처면 문서가 많은 칸(같으면 먼저 생긴 id)을 남긴다 */
export function mergeDirection(a: Cat, b: Cat): { from: Cat; into: Cat } {
  const keepA = a.origin === "SEED" && b.origin !== "SEED" ? true
    : b.origin === "SEED" && a.origin !== "SEED" ? false
    : a.doc_count !== b.doc_count ? a.doc_count > b.doc_count : a.category_id < b.category_id;
  return keepA ? { from: b, into: a } : { from: a, into: b };
}

export function makeHandler(d: Deps) {
  return async () => {
    // ① 임베딩 채우기
    const missing = await d.q<Cat>("SELECT category_id, name, description FROM categories WHERE embedding IS NULL AND merged_into IS NULL");
    for (const c of missing) {
      await d.q("UPDATE categories SET embedding = :v::vector, updated_at = now() WHERE category_id = :id", { id: c.category_id, v: vec(await d.embed(`${c.name}: ${c.description}`)) });
    }
    // ② 유사 칸 병합 (같은 부모, 둘 다 살아 있는 칸)
    const pairs = await d.q<{ a: string; b: string; sim: number }>(`
      SELECT a.category_id AS a, b.category_id AS b, 1 - (a.embedding <=> b.embedding) AS sim
      FROM categories a JOIN categories b ON a.category_id < b.category_id AND a.parent_id IS NOT DISTINCT FROM b.parent_id
      WHERE a.merged_into IS NULL AND b.merged_into IS NULL AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
        AND 1 - (a.embedding <=> b.embedding) >= :min ORDER BY sim DESC`, { min: MERGE_SIM });
    const gone = new Set<string>();
    let merged = 0;
    for (const p of pairs) {
      if (gone.has(p.a) || gone.has(p.b)) continue;
      const cats = await d.q<Cat>("SELECT category_id, parent_id, name, description, origin, doc_count FROM categories WHERE category_id IN (:a, :b)", { a: p.a, b: p.b });
      if (cats.length !== 2) continue;
      const { from, into } = mergeDirection(cats[0]!, cats[1]!);
      if (from.origin === "SEED") continue; // SEED 끼리는 사람이 만든 체계라 자동 병합하지 않음
      await d.tx(async (q) => {
        const moved = await q<{ doc_id: string }>("UPDATE documents SET category_id = :into WHERE category_id = :from RETURNING doc_id", { from: from.category_id, into: into.category_id });
        await q("UPDATE categories SET merged_into = :into, doc_count = 0, updated_at = now() WHERE category_id = :from", { from: from.category_id, into: into.category_id });
        await q("UPDATE categories SET doc_count = doc_count + :n, updated_at = now() WHERE category_id = :into", { into: into.category_id, n: moved.length });
        await q("UPDATE categories SET parent_id = :into WHERE parent_id = :from AND merged_into IS NULL", { from: from.category_id, into: into.category_id }); // 하위 칸은 새 부모로
        await q("INSERT INTO category_events (actor, action, category_id, target_id, detail) VALUES ('AI', 'MERGE', :from, :into, :detail::jsonb)",
          { from: from.category_id, into: into.category_id, detail: { similarity: Math.round(p.sim * 1000) / 1000, from_name: from.name, into_name: into.name, moved_docs: moved.length } });
      });
      gone.add(from.category_id);
      merged++;
    }
    // ③ 빈 AI 칸 정리 (하위 칸도 없을 때만)
    const empty = await d.q<{ category_id: string; parent_id: string | null; name: string }>(`
      SELECT c.category_id, c.parent_id, c.name FROM categories c
      WHERE c.origin = 'AI' AND c.merged_into IS NULL AND c.doc_count = 0 AND c.created_at < now() - make_interval(days => :days::int)
        AND NOT EXISTS (SELECT 1 FROM categories k WHERE k.parent_id = c.category_id AND k.merged_into IS NULL)`, { days: EMPTY_DAYS });
    for (const c of empty) {
      const into = c.parent_id ?? "cat_etc";
      await d.tx(async (q) => {
        await q("UPDATE categories SET merged_into = :into, updated_at = now() WHERE category_id = :id", { id: c.category_id, into });
        await q("INSERT INTO category_events (actor, action, category_id, target_id, detail) VALUES ('AI', 'MERGE', :id, :into, :detail::jsonb)",
          { id: c.category_id, into, detail: { reason: `문서 0건 ${EMPTY_DAYS}일 경과`, from_name: c.name } });
      });
    }
    const out = { embedded: missing.length, merged, retired: empty.length };
    console.log(JSON.stringify({ job: "category-sweep", ...out }));
    return out;
  };
}

// ---------- Lambda 연결 ----------
const bedrock = new BedrockRuntimeClient({});
let pg: ReturnType<typeof db> | undefined;
const store = () => (pg ??= db());

export const handler = makeHandler({
  q: (sql, params) => store().query(sql, params),
  tx: (fn) => store().tx(fn),
  embed: async (text) => {
    const r = await bedrock.send(new InvokeModelCommand({
      modelId: process.env.MODEL_EMBED, contentType: "application/json", accept: "application/json",
      body: JSON.stringify({ inputText: text.slice(0, 2000), dimensions: 1024, normalize: true }),
    }));
    return (JSON.parse(new TextDecoder().decode(r.body)) as { embedding: number[] }).embedding;
  },
});
