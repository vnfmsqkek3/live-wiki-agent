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
    return { result: 'QUARANTINED', authority_status: 'REJECTED', findings: [fnd('HIGH', 'SECURITY_POLICY', '보안 검사 HIGH 탐지 → 격리', 'prior-findings', {
      user_message: '앞선 보안 검사에서 위험 요소가 발견되어 문서를 격리했습니다. 위 항목에 쪽·이유가 있습니다.', fix_hint: '위 항목의 안내대로 고친 파일을 새로 올려 주세요.' })] };

  let review = prior.some((f) => f.severity !== 'LOW');
  let authority: AuthorityStatus = 'UNVERIFIED';
  const c = i.doc.classification;
  if (!c || c.confidence < 0.7) {
    review = true;
    findings.push(fnd('MEDIUM', 'CLASSIFY_LOW_CONFIDENCE', '분류 실패 또는 신뢰도 0.7 미만', 'classification', {
      user_message: `문서 종류(규정·노하우·매뉴얼)를 자동으로 확실히 판단하지 못했습니다${c ? ` (신뢰도 ${c.confidence.toFixed(2)})` : ''}.`,
      fix_hint: '검토 화면에서 문서 종류를 직접 골라 주세요.' }));
  }

  if (c?.document_type === 'REGULATION' || i.claimed) {
    if (!i.claimed || !i.registry) {
      review = true;
      findings.push(fnd('MEDIUM', 'REGISTRY_NOT_FOUND', 'Trusted Registry에 해당 규정 없음 → 공식 검증 불가', i.claimed?.law_id ?? 'unknown', {
        user_message: '공식 규정 목록(Trusted Registry)에서 이 규정을 찾지 못해 공식 원본인지 확인할 수 없습니다.',
        fix_hint: '규정 담당 부서가 배포한 공식 원본 파일을 그대로 올려 주세요. 신규 규정이면 관리자에게 등록을 요청하세요.' }));
    } else if (sameHash(i.registry.content_hash, i.doc.content_hash)) {
      authority = 'VERIFIED';
    } else {
      review = true;
      const diff = diffClauses(i.registry.clauses, i.claimed.clauses);
      findings.push(fnd('HIGH', 'REGISTRY_MISMATCH',
        `공식 원본과 내용 불일치${diff.length ? ` (조문 ${diff.length}개: ${diff.slice(0, 5).join(', ')})` : ''} · 위조 확정 아님, 출처 검토 필요`,
        `${i.registry.law_id}@${i.registry.revision_id}`, {
          user_message: `공식 원본과 내용이 다른 조문이 ${diff.length || '여러'}곳 있습니다${diff.length ? ` (${diff.slice(0, 3).map(label).join(', ')}${diff.length > 3 ? ` 외 ${diff.length - 3}곳` : ''})` : ''}. 위조로 확정한 것은 아니며 출처 확인이 필요합니다.`,
          fix_hint: '공식 원본 파일을 그대로 올려 주세요. 문서보관함 밑줄에서 조문별로 공식 원문과 비교할 수 있습니다.' }));
    }
  } else {
    // 노하우·매뉴얼은 사람 승인으로만 VERIFIED가 된다
    authority = 'UNVERIFIED';
  }

  return { result: review ? 'REVIEW_REQUIRED' : 'PASS', authority_status: authority, findings };
}

/** `sha256:{hex}`·hex 표기 차이를 무시하고 비교 */
const sameHash = (a?: string, b?: string) => !!a && !!b && a.replace(/^sha256:/, '').toLowerCase() === b.replace(/^sha256:/, '').toLowerCase();

export function diffClauses(official?: Record<string, string>, uploaded?: Record<string, string>) {
  if (!official || !uploaded) return [];
  const ids = new Set([...Object.keys(official), ...Object.keys(uploaded)]);
  return [...ids].filter((k) => official[k] !== uploaded[k]).sort();
}

function fnd(severity: Finding['severity'], code: string, message: string, evidence_ref: string, extra: Pick<Finding, 'location' | 'user_message' | 'fix_hint'> = {}): Finding {
  return { finding_id: newId.fnd(), step: 'TRUST_GATE', severity, code, message, evidence_ref, ...extra };
}

/** 'ARTICLE:12/PARAGRAPH:1' → '제12조제1항'. 3단 가지번호 'ARTICLE:2-1-2' → '제2-1조의2' (schemas PR #114) */
export const label = (p: string) => p.split('/').map((x) => {
  const [k, n] = x.split(':'); const [a, b, c] = (n ?? '').split('-');
  return k === 'ARTICLE' ? (c ? `제${a}-${b}조의${c}` : `제${a}조${b ? `의${b}` : ''}`) : k === 'PARAGRAPH' ? `제${a}항` : k === 'ITEM' ? `제${a}호` : '';
}).join('');
