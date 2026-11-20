// 외부 법령 찾기: 문서보관함 '외부 법령 참고'(GET /v1/library/:id/external-laws)와 노하우·매뉴얼 외부 법령 대조(AI팀 knowhow.ts)가 같이 쓴다.
// 1) 괄호·조문 표기 (데이터팀 externalLawRefs: 법령당 1건 {law_name, clause?, clauses[]}) 2) 괄호 없는 언급 (모델, steps/external-laws.ts)
import { structured } from './model.ts';
import { LAW_SCHEMA, LAW_SYSTEM, mergeLaws, type LawRef } from './steps/external-laws.ts';

type Ref = { law_name: string; clause?: string; clauses?: string[] };
type Reg = { externalLaws: (t: string, s: unknown) => Promise<string[]>; externalLawRefs?: (t: string, s: unknown, max?: number) => Promise<Ref[]>; DynamoClauseStore: new (t: string) => unknown };

/** 조문마다 1건으로 편다 (clauses 가 없던 옛 모양은 clause 1건) */
export const flatRefs = (refs: Ref[]): LawRef[] =>
  refs.flatMap((r) => (r.clauses?.length ? r.clauses : r.clause ? [r.clause] : [undefined]).map((clause) => ({ law_name: r.law_name, ...(clause ? { clause } : {}) })));

export async function findExternalLaws(text: string): Promise<LawRef[]> {
  if (!process.env.TABLE_REGULATIONS) return [];
  const reg = (await import('@hanaeum/regulation-server')) as unknown as Reg;
  const store = new reg.DynamoClauseStore(process.env.TABLE_REGULATIONS);
  const bracket: LawRef[] = reg.externalLawRefs ? flatRefs(await reg.externalLawRefs(text, store, 10)) : (await reg.externalLaws(text, store)).map((law_name) => {
    const m = new RegExp(`「${law_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}」\\s*(제\\d+조(?:의\\d+)?(?:제\\d+항)?)`).exec(text);
    return { law_name, ...(m ? { clause: m[1] } : {}) };
  });
  // 괄호가 없어도 법령을 가리키는 곳 (사용자 지적 11/18): 모델이 뽑고, 내부 규정 저장소에 있는 이름은 뺀다
  const found = await structured<{ laws: LawRef[] }>('HAIKU', LAW_SYSTEM, text.slice(0, 20000), 'submit_laws', LAW_SCHEMA as unknown as Record<string, unknown>).then((r) => r.value.laws ?? []).catch(() => [] as LawRef[]);
  const external = await Promise.all(found.map(async (l) => ((await reg.externalLaws(`「${l.law_name}」`, store).catch(() => [])).length ? l : null)));
  return mergeLaws(bracket, external.filter((x): x is LawRef => !!x));
}
