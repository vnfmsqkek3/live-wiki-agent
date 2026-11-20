// 측정 스크립트 출력(markdown 표 + 두 칸 들여쓴 실패 줄) → 평가 항목·실패 목록. 측정 코드는 데이터QA팀 소유라 출력만 읽는다
export interface Item { key: string; label: string; target: string; passed: number; total: number; pass: boolean }
export interface Failure { key: string; case_id: string; reason: string }

// 표 항목 이름 → sets.json·docs/02 4장 키 (GET /v1/admin/evaluations 의 key)
const KEYS: [RegExp, string][] = [
  [/법령 구조 파싱|^파싱/, "parsing_95"], [/정확 조문 검색|조문 (검색 )?실패/, "clause_lookup_19_20"], [/삭제 조항/, "deleted_clause_0"],
  [/변경 영향/, "impact"], [/KB (가시성|노출)/, "kb_invisible_before_approval"], [/근거 인용/, "citation_19_20"], [/검색 실패 판정/, "unverified_0"],
];
const keyOf = (label: string, dflt = label) => KEYS.find(([r]) => r.test(label))?.[1] ?? dflt;

export function parse(out: string, source: string): { items: Item[]; failures: Failure[] } {
  const items: Item[] = [], failures: Failure[] = [];
  for (const line of out.split("\n")) {
    const c = line.split("|").map((s) => s.trim());
    if (c.length >= 6 && /^(통과|미달)$/.test(c[4]!)) {
      const [, label, target, value, verdict] = c as [string, string, string, string, string];
      const m = value.match(/(\d+)\/(\d+)/);
      const pass = verdict === "통과";
      // "0건" 같은 목표는 a/b 가 없다: 1건 중 통과 여부로
      items.push({ key: keyOf(label), label, target, passed: m ? Number(m[1]) : pass ? 1 : 0, total: m ? Number(m[2]) : 1, pass });
    } else if (/^ {2}\S/.test(line)) {
      // 실패 줄은 표 뒤에 몰려 나온다: 줄 머리말로 항목을 정한다. 케이스 ID·조문 경로만 담지만(원문 없음) 길이는 자른다
      failures.push({ key: keyOf(line.trim(), source), case_id: line.match(/\b([A-Z]{1,5}(?:-[A-Z0-9]+)+)\b/)?.[1] ?? "", reason: line.trim().slice(0, 300) });
    }
  }
  return { items, failures };
}
