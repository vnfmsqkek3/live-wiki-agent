import { describe, expect, it } from "vitest";
import { makeHandler, mergeDirection, type Cat } from "./category-sweep.js";

const cat = (id: string, origin: string, doc_count: number): Cat => ({ category_id: id, parent_id: "cat_admin", name: id, description: "", origin, doc_count });

describe("mergeDirection", () => {
  it("keeps the SEED category", () => {
    expect(mergeDirection(cat("cat_admin_office", "SEED", 1), cat("cat_x", "AI", 9)).into.category_id).toBe("cat_admin_office");
    expect(mergeDirection(cat("cat_x", "AI", 9), cat("cat_admin_office", "SEED", 1)).into.category_id).toBe("cat_admin_office");
  });
  it("between AI categories keeps the one with more documents", () => {
    expect(mergeDirection(cat("cat_a", "AI", 1), cat("cat_b", "AI", 5))).toMatchObject({ from: { category_id: "cat_a" }, into: { category_id: "cat_b" } });
  });
});

describe("category-sweep", () => {
  it("fills embeddings, merges a similar AI category into SEED, retires empty AI categories, logs every change", async () => {
    const sqls: { sql: string; p?: Record<string, unknown> }[] = [];
    const q = async <T>(sql: string, p?: Record<string, unknown>): Promise<T[]> => {
      sqls.push({ sql: sql.replace(/\s+/g, " ").trim(), p });
      if (sql.includes("embedding IS NULL")) return [{ category_id: "cat_new", name: "프린터", description: "복합기 설치" }] as T[];
      if (sql.includes("<=>")) return [{ a: "cat_admin_office", b: "cat_printer", sim: 0.93 }] as T[];
      if (sql.includes("WHERE category_id IN")) return [cat("cat_admin_office", "SEED", 3), cat("cat_printer", "AI", 2)] as T[];
      if (sql.startsWith("UPDATE documents")) return [{ doc_id: "d1" }, { doc_id: "d2" }] as T[];
      if (sql.includes("c.origin = 'AI'")) return [{ category_id: "cat_old", parent_id: "cat_admin", name: "옛 칸" }] as T[];
      return [];
    };
    const out = await makeHandler({ q, tx: (fn) => fn(q), embed: async () => [0.1, 0.2] })();
    expect(out).toEqual({ embedded: 1, merged: 1, retired: 1 });
    expect(sqls.find((s) => s.sql.startsWith("UPDATE documents"))!.p).toEqual({ from: "cat_printer", into: "cat_admin_office" });
    const events = sqls.filter((s) => s.sql.includes("INSERT INTO category_events"));
    expect(events).toHaveLength(2);
    expect(events[0]!.p).toMatchObject({ from: "cat_printer", into: "cat_admin_office", detail: { similarity: 0.93, moved_docs: 2 } });
    expect(events[1]!.p).toMatchObject({ id: "cat_old", into: "cat_admin" });
  });
});
