// 단계 9 TrustGate. 앞 단계 Findings + 분류 + Trusted Registry 대조 → PASS / REVIEW_REQUIRED / QUARANTINED.
// AI 단독으로 "위조 확정"하지 않는다: Registry 불일치는 QUARANTINED가 아니라 REVIEW_REQUIRED + UNVERIFIED.
import { newId, type AuthorityStatus, type DocumentRecord, type Finding, type TrustGateResult } from '../contracts.ts';

export interface RegistryEntry {
  law_id: string;
  revision_id: string;
  content_hash: string;
  effective_from: string;
  clauses?: Record<string, string>; // provision_id → 정규화 본문
}

export interface TrustGateInput {
  doc: Pick<DocumentRecord, 'classification' | 'content_hash' | 'findings'>;
  claimed?: { law_id: string; revision_id?: string; clauses?: Record<string, string> }; // 문서가 주장하는 공식 규정
  registry?: RegistryEntry; // let522mj Registry 조회 결과 (없으면 미등록)
}

export interface TrustGateOutput {
  result: TrustGateResult;
  authority_status: AuthorityStatus;
  findings: Finding[];
}

const QUARANTINE_STEPS = new Set(['TYPE_DETECTION', 'MALWARE', 'FILE_STRUCTURE', 'INJECTION_SCAN']);

export function trustGate(i: TrustGateInput): TrustGateOutput {
  const findings: Finding[] = [];
  const prior = i.doc.findings;

  if (prior.some((f) => f.severity === 'HIGH' && QUARANTINE_STEPS.has(f.step)))
    return { result: 'QUARANTINED', authority_status: 'REJECTED', findings: [fnd('HIGH', 'SECURITY_POLICY', '보안 검사 HIGH 탐지 → 격리', 'prior-findings')] };

  let review = prior.some((f) => f.severity !== 'LOW');
  let authority: AuthorityStatus = 'UNVERIFIED';
  const c = i.doc.classification;
  if (!c || c.confidence < 0.7) {
    review = true;
    findings.push(fnd('MEDIUM', 'CLASSIFY_LOW_CONFIDENCE', '분류 실패 또는 신뢰도 0.7 미만', 'classification'));
  }

  if (c?.document_type === 'REGULATION' || i.claimed) {
    if (!i.claimed || !i.registry) {
      review = true;
      findings.push(fnd('MEDIUM', 'REGISTRY_NOT_FOUND', 'Trusted Registry에 해당 규정 없음 → 공식 검증 불가', i.claimed?.law_id ?? 'unknown'));
    } else if (i.registry.content_hash === i.doc.content_hash) {
      authority = 'VERIFIED';
    } else {
      review = true;
      const diff = diffClauses(i.registry.clauses, i.claimed.clauses);
      findings.push(fnd('HIGH', 'REGISTRY_MISMATCH',
        `공식 원본과 내용 불일치${diff.length ? ` (조문 ${diff.length}개: ${diff.slice(0, 5).join(', ')})` : ''} · 위조 확정 아님, 출처 검토 필요`,
        `${i.registry.law_id}@${i.registry.revision_id}`));
    }
  } else {
    // 노하우·매뉴얼은 사람 승인으로만 VERIFIED가 된다
    authority = 'UNVERIFIED';
  }

  return { result: review ? 'REVIEW_REQUIRED' : 'PASS', authority_status: authority, findings };
}

export function diffClauses(official?: Record<string, string>, uploaded?: Record<string, string>) {
  if (!official || !uploaded) return [];
  const ids = new Set([...Object.keys(official), ...Object.keys(uploaded)]);
  return [...ids].filter((k) => official[k] !== uploaded[k]).sort();
}

function fnd(severity: Finding['severity'], code: string, message: string, evidence_ref: string): Finding {
  return { finding_id: newId.fnd(), step: 'TRUST_GATE', severity, code, message, evidence_ref };
}
