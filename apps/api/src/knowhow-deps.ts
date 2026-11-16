// 노하우 검증 실제 의존성 (let522mj 패키지): 조문 조회 = ClauseStore, 인용 추출 = graph-server extractCitations,
// 의미 검색 = search-server search_wiki(legal-clauses, ACL·현재 상태 재검증 포함), 판정 = model.ts (Sonnet, 구조화 출력)
import type { Clause, KnowhowDeps } from './steps/knowhow.ts';

/** ClauseStore 최소 형태 (@hanaeum/regulation-server) */
export interface ClauseStoreLike {
  lawIdByName(name: string): Promise<string | undefined>;
  revisions(lawId: string): Promise<{ law_id: string; law_name: string; revision_id: string; effective_from: number; effective_to: number; authority_status?: string }[]>;
  provisions(lawId: string, revisionId: string): Promise<{ provision_id: string; path_label: string; original_text: string; status: string }[] | undefined>;
}

const ymd = (d = new Date()) => Number(d.toISOString().slice(0, 10).replaceAll('-', ''));
const iso = (n: number) => `${String(n).slice(0, 4)}-${String(n).slice(4, 6)}-${String(n).slice(6, 8)}`;
const relPath = (pid: string) => pid.slice(pid.indexOf('/') + 1);

/** provision_id(`LAW@REV/ARTICLE:n/...`) → 조문 원문(하위 호·목 포함)·상태·현행 조문 */
export function clauseGetter(store: ClauseStoreLike, today = ymd) {
  return async (pid: string): Promise<Clause | undefined> => {
    const m = /^([^@]+)@(\d{4}-\d{2}-\d{2})\/(.+)$/.exec(pid);
    if (!m) return undefined;
    const [, lawId, revId, path] = m as unknown as [string, string, string, string];
    const revs = await store.revisions(lawId);
    const rev = revs.find((r) => r.revision_id === revId);
    if (!rev) return undefined;
    const build = async (r: typeof rev, p: string): Promise<Omit<Clause, 'current'> | undefined> => {
      const provs = await store.provisions(r.law_id, r.revision_id);
      const self = provs?.find((x) => relPath(x.provision_id) === p);
      if (!provs || !self) return undefined;
      const kids = provs.filter((x) => relPath(x.provision_id).startsWith(`${p}/`)).map((x) => x.original_text);
      return {
        provision_id: self.provision_id, label: `${r.law_name} ${self.path_label}`, text: [self.original_text, ...kids].join(' '),
        status: self.status === 'DELETED' ? 'DELETED' : 'ACTIVE', effective_from: iso(r.effective_from),
      };
    };
    const cl = await build(rev, path);
    if (!cl) return undefined;
    const t = today();
    const cur = revs.filter((r) => r.effective_from <= t && t <= r.effective_to && (r.authority_status ?? 'VERIFIED') === 'VERIFIED')
      .sort((a, b) => b.effective_from - a.effective_from)[0];
    if (!cur || cur.revision_id === rev.revision_id) return cl;
    const current = await build(cur, path);
    return { ...cl, status: cl.status === 'DELETED' ? 'DELETED' : 'HISTORICAL', ...(current ? { current } : {}) };
  };
}

export interface KnowhowRealDeps {
  store: ClauseStoreLike;
  extract(text: string, store: ClauseStoreLike, asOf: number): Promise<{ provision_id: string; evidence_span: string; confidence: number }[]>;
  /** search_wiki(legal-clauses) 결과의 조문 ID 목록 */
  searchProvisionIds(text: string): Promise<string[]>;
  judge: KnowhowDeps['judge'];
}

export function knowhowDeps(r: KnowhowRealDeps): KnowhowDeps {
  const getClause = clauseGetter(r.store);
  return {
    extractCitations: (text) => r.extract(text, r.store, ymd()),
    getClause,
    searchClauses: async (text) => {
      const ids = await r.searchProvisionIds(text.slice(0, 1000));
      const out: Clause[] = [];
      for (const id of ids) { const c = await getClause(id); if (c) out.push(c); }
      return out;
    },
    judge: r.judge,
  };
}
