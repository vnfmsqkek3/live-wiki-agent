// 살아있는 위키: 게시된 노하우의 근거 규정이 개정·시행되면 "검토 필요"로 바꾼다 (docs/02 데모 04, Change Impact).
// 저장된 노하우 판정의 인용 조문(provision_id = LAW@REV/...)으로 찾는다. 자동 수정·자동 게시는 하지 않는다.
// ponytail: 같은 규정의 다른 개정판을 인용하면 표시한다(조문별 변경 여부 미확인). Neptune trace_impact 배포 후 변경 조문만으로 좁힌다
import type { DocumentRecord } from '../contracts.ts';

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const typeOf = (d: DocumentRecord) => d.document_type ?? d.classification?.document_type; // 초기 게시본은 최상위 값 없음
const lawRev = (pid: string) => { const [lr] = pid.split('/'); const [law, rev] = lr!.split('@'); return { law: law!, rev: rev ?? '' }; };

/** 오늘 시행 중인 게시 규정 개정판 (law_id → revision_id) */
export function currentRevisions(docs: DocumentRecord[], today = ymd(new Date())) {
  const cur = new Map<string, DocumentRecord>();
  for (const d of docs) {
    if (d.lifecycle !== 'PUBLISHED' || typeOf(d) !== 'REGULATION' || !d.law_id || !d.revision_id) continue;
    if ((d.effective_from ?? '0000') > today || (d.effective_to ?? '9999-12-31') < today) continue;
    const prev = cur.get(d.law_id);
    if (!prev || (prev.effective_from ?? '') < (d.effective_from ?? '')) cur.set(d.law_id, d);
  }
  return cur;
}

/** 근거 규정이 바뀐 게시 노하우 → 바꿀 레코드 목록 (멱등: 이미 표시된 문서는 제외). lawIds가 있으면 그 규정만 */
export function staleKnowhow(docs: DocumentRecord[], today = ymd(new Date()), lawIds?: string[]): DocumentRecord[] {
  const cur = currentRevisions(docs, today);
  const at = new Date().toISOString();
  const out: DocumentRecord[] = [];
  for (const d of docs) {
    if (d.lifecycle !== 'PUBLISHED' || typeOf(d) === 'REGULATION' || d.freshness !== 'CURRENT') continue;
    const cited = [
      ...(d.knowhow_validation?.items ?? []).filter((j) => j.verified_quote && (j.relation === 'SUPPORTS' || j.relation === 'SUPPLEMENTS' || j.relation === 'CONFLICTS')).map((j) => j.provision_id),
      ...(d.citations ?? []).map((c) => c.provision_id),
    ];
    const changed = cited.filter((pid) => {
      const { law, rev } = lawRev(pid);
      const now = cur.get(law);
      return now && (!lawIds || lawIds.includes(law)) && now.revision_id !== rev
        && !d.freshness_confirmed?.some((x) => x.law_id === law && x.revision === now.revision_id); // 결재자가 이 개정판 기준으로 유효 확인함
    });
    if (!changed.length) continue;
    const { law, rev } = lawRev(changed[0]!);
    const now = cur.get(law)!;
    out.push({
      ...d, freshness: 'REVIEW_REQUIRED', updated_at: at,
      freshness_reason: { law_id: law, law_name: now.law_name ?? now.title, cited_revision: rev, current_revision: now.revision_id!, effective_from: now.effective_from ?? '', provisions: [...new Set(changed)], at },
    });
  }
  return out;
}
