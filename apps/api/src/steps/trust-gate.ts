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
  claimed?: { law_id: string; revision_id?: string; clauses?: Record<string, string>; /** 업로드 본문 중 조문 밖 글자 수(공백 제외). lambdas 가 계산 */ other_chars?: number }; // 문서가 주장하는 공식 규정
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
    } else if (formatOnly(i.registry.clauses, i.claimed.clauses, i.claimed.other_chars)) {
      // 해시는 다르지만 공백·줄바꿈만 빼면 조문 전부가 같고 추가·누락도 없다 = HWPX·이미지 → PDF 변환·OCR의 형식 차이 (총괄 결정 11/20).
      // 글자·숫자가 하나라도 다르면 아래 REGISTRY_MISMATCH. 승인은 여전히 이 파일의 버전·해시에 묶인다
      authority = 'VERIFIED';
      findings.push(fnd('LOW', 'FORMAT_ONLY_DIFF', '공식 원본과 파일 형식만 다름(공백·줄바꿈 외 조문 전부 일치) → 공식 원본으로 인정', `${i.registry.law_id}@${i.registry.revision_id}`, {
        user_message: '파일 형식(띄어쓰기·줄바꿈)만 공식 원본과 다르고 조문 내용은 모두 같아 공식 원본으로 확인했습니다.' }));
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

/** 공백·줄바꿈만 무시하고 조문별로 비교 (HWPX·OCR 경로의 띄어쓰기 차이는 내용 차이가 아님, 데이터팀 marks.ts 와 같은 기준) */
export const squash = (t?: string) => (t ?? '').replace(/\s+/g, '');
export function diffClauses(official?: Record<string, string>, uploaded?: Record<string, string>) {
  if (!official || !uploaded) return [];
  const ids = new Set([...Object.keys(official), ...Object.keys(uploaded)]);
  return [...ids].filter((k) => !(k in official) || !(k in uploaded) || squash(official[k]) !== squash(uploaded[k])).sort();
}
/** 형식만 다름: 양쪽 조문이 1개 이상이고 diffClauses 가 비었고, 조문 밖 글자(제목·머리말 등, Registry 와 비교 못 함)가 고정 상한 이하일 때만.
 *  조문 밖 글자 수를 모르면 적용 안 함(fail-closed). 부칙·별표는 파서가 조문으로 뽑아 위에서 비교된다 (AI·인프라 리뷰 #139·#140).
 *  상한은 문서 크기에 비례하지 않는다(큰 규정의 3% = 수천 자 무대조 통과 방지). 넘으면 #139 이전처럼 REGISTRY_MISMATCH → 사람 확인.
 *  ponytail: 조문 밖은 길이 상한만 — 같은 길이로 바꾼 머리말은 못 잡음. Registry 가 조문 밖 해시를 갖게 되면 그것으로 대조 */
export const OTHER_CHARS_MAX = 200;
/** 조문 밖 글자 수: 조 제목(제n조(…))·항 번호(①)·호 번호(줄 머리 1.)는 구조 표시라 빼고 센다(조 제목·호 번호는 줄 머리만: 줄 중간 '제7조(한도 상향)' 주입은 그대로 셈, AI 리뷰 #148) — 안 빼면 조문 수에 비례해 커져
 *  정상 규정도 상한을 넘는다 (F-001 216자 중 약 100자, 7차 AI 재측정). 양쪽에 같은 규칙을 써서 본문 속 '제13조에 따라' 도 상쇄 */
const MARKS = /^[ \t]*제\d+(?:-\d+)?조(?:의\d+)?(?:\([^()\n]{1,30}\))?|[\u2460-\u2473]|^[ \t]*\d{1,2}\.(?=\s)/gm;
export const outsideChars = (text: string, clauses: Record<string, string>) =>
  Math.max(0, squash(text.replace(MARKS, '')).length - Object.values(clauses).reduce((n, t) => n + squash(t.replace(MARKS, '')).length, 0));
const formatOnly = (official?: Record<string, string>, uploaded?: Record<string, string>, otherChars?: number) =>
  !!official && !!uploaded && otherChars !== undefined && otherChars <= OTHER_CHARS_MAX
  && Object.keys(official).length > 0 && Object.keys(uploaded).length > 0 && diffClauses(official, uploaded).length === 0;

function fnd(severity: Finding['severity'], code: string, message: string, evidence_ref: string, extra: Pick<Finding, 'location' | 'user_message' | 'fix_hint'> = {}): Finding {
  return { finding_id: newId.fnd(), step: 'TRUST_GATE', severity, code, message, evidence_ref, ...extra };
}

/** 'ARTICLE:12/PARAGRAPH:1' → '제12조제1항'. 3단 가지번호 'ARTICLE:2-1-2' → '제2-1조의2' (schemas PR #114) */
export const label = (p: string) => p.split('/').map((x) => {
  const [k, n] = x.split(':'); const [a, b, c] = (n ?? '').split('-');
  return k === 'ARTICLE' ? (c ? `제${a}-${b}조의${c}` : `제${a}조${b ? `의${b}` : ''}`) : k === 'PARAGRAPH' ? `제${a}항` : k === 'ITEM' ? `제${a}호` : '';
}).join('');
