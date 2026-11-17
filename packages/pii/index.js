// @ts-check
// 개인정보 탐지·마스킹 순수 함수 (의존성 없음). API 단계 6, Agent 질의 검사, ImageDescribe(yoyo0704)가 함께 쓴다.
// Lambda zip의 node_modules에서도 실행되도록 빌드 없는 JS + 타입 선언(index.d.ts).
/** @typedef {'RRN' | 'FOREIGNER_NO' | 'PASSPORT' | 'DRIVER_LICENSE' | 'CARD' | 'ACCOUNT' | 'CUSTOMER_NO' | 'IP_ADDRESS'} PiiType */
/** @typedef {{ type: PiiType; start: number; end: number; certain: boolean }} PiiSpan */

/** 화면·Finding 메시지용 한글 이름 */
/** @type {Record<PiiType, string>} */
export const PII_NAME = { RRN: '주민등록번호', FOREIGNER_NO: '외국인등록번호', PASSPORT: '여권번호', DRIVER_LICENSE: '운전면허번호', CARD: '카드번호', ACCOUNT: '계좌번호', CUSTOMER_NO: '고객번호', IP_ADDRESS: 'IP 주소' };

/** @type {Record<PiiType, string>} */
const LABEL = {
  RRN: '[주민등록번호]',
  FOREIGNER_NO: '[외국인등록번호]',
  PASSPORT: '[여권번호]',
  DRIVER_LICENSE: '[운전면허번호]',
  CARD: '[카드번호]',
  ACCOUNT: '[계좌번호]',
  CUSTOMER_NO: '[고객번호]',
  IP_ADDRESS: '[IP 주소]',
};

/** 주민등록번호(외국인등록번호 포함) 체크섬. 2020-10 이후 발급분은 체크섬이 없어 실패할 수 있다. */
/** @param {string} d */
export function rrnChecksumOk(d) {
  const w = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  const sum = w.reduce((s, x, i) => s + x * Number(d[i]), 0);
  return (11 - (sum % 11)) % 10 === Number(d[12]);
}

/** @param {string} d */
function rrnDateOk(d) {
  const mm = Number(d.slice(2, 4));
  const dd = Number(d.slice(4, 6));
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && '12345678'.includes(d[6] ?? 'x');
}

/** @param {string} d */
export function luhnOk(d) {
  let s = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    s += n;
  }
  return s % 10 === 0;
}

/** @type {{ type: PiiType; re: RegExp; judge?: (digits: string) => boolean | 'uncertain' }[]} */
const RULES = [
  // IPv4 (사용자 결정 11/17): 값은 가리되 '[IP 주소]' 자리 표시로 남겨 가이드가 "이 칸에 장비 IP를 넣는다"를 알 수 있게.
  // 검게 칠하거나 {IP_ADDRESS}로 지우지 않는다. 버전 번호(1.2.3)·날짜(2026.11.17)와 겹치지 않게 네 마디·0~255만
  { type: 'IP_ADDRESS', re: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\d|\.\d)/g }, // 뒤 '.'은 다음 마디(숫자)가 올 때만 막음: 문장 끝 마침표 허용
  // 운전면허번호: 지역번호(11~28) 또는 지역명 - 2 - 6 - 2. 계좌 형태 규칙보다 먼저
  { type: 'DRIVER_LICENSE', re: /(?<![\d-])(?:1[1-9]|2[0-8]|서울|부산|경기|강원|충북|충남|전북|전남|경북|경남|제주|대구|인천|광주|대전|울산)[- ]?\d{2}-\d{6}-\d{2}(?![\d-])/g },
  // 여권번호: 영문 1자 + 숫자 8자리(구) 또는 영문 1 + 숫자 3 + 영문 1 + 숫자 4(2021~). "여권" 문맥이 있으면 확실, 없으면 불확실(사람 검토)
  { type: 'PASSPORT', re: /(?<=여권\s*(번호)?\s*[:：]?\s*)[A-Z](?:\d{8}|\d{3}[A-Z]\d{4})(?![A-Z0-9])/g },
  { type: 'PASSPORT', re: /(?<![A-Za-z0-9])[MSRGD](?:\d{8}|\d{3}[A-Z]\d{4})(?![A-Za-z0-9])/g, judge: () => 'uncertain' },
  {
    // 외국인등록번호: 주민등록번호와 같은 형식, 성별 자리 5~8
    type: 'FOREIGNER_NO',
    re: /(?<!\d)\d{6}\s?-?\s?[5-8]\d{6}(?!\d)/g,
    judge: (d) => (!rrnDateOk(d) ? false : rrnChecksumOk(d) ? true : 'uncertain'),
  },
  {
    type: 'RRN',
    re: /(?<!\d)\d{6}\s?-?\s?[1-4]\d{6}(?!\d)/g,
    judge: (d) => (!rrnDateOk(d) ? false : rrnChecksumOk(d) ? true : 'uncertain'),
  },
  { type: 'CARD', re: /(?<!\d)\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}(?!\d)/g, judge: (d) => luhnOk(d) || 'uncertain' },
  // 전화번호·이메일은 가리지 않는다 (사용자 결정 11/17 22시: 가이드가 담당자 연락처·이메일을 안내). 고객 연락처도 그대로 보임
  // 금융 사전: "계좌", "고객번호" 문맥 뒤 숫자열
  { type: 'ACCOUNT', re: /(?<=계좌\s*(번호)?\s*[:：]?\s*)\d[\d-]{8,18}\d/g },
  { type: 'CUSTOMER_NO', re: /(?<=고객\s*(번호|ID)\s*[:：]?\s*)[A-Z]{0,3}\d{6,12}/g },
  // 문맥 없는 계좌 형태(3-2~6-2~8) → 불확실
  // 전화번호 모양(010-1234-5678, 02-123-4567, 031-123-4567)은 계좌로 보지 않는다 (전화는 가리지 않음, 사용자 결정 11/17 22시)
  { type: 'ACCOUNT', re: /(?<!\d)(?!01[016789]-\d{3,4}-\d{4}(?!\d))(?!0(?:2|[3-6][1-5])-\d{3,4}-\d{4}(?!\d))\d{3,6}-\d{2,6}-\d{2,8}(?!\d)/g, judge: (d) => (isDate(d) ? false : 'uncertain') },
];

/** YYYYMMDD 형태의 실제 날짜 (시행일 2026-11-01 등을 계좌로 오탐하지 않도록) */
/** @param {string} d */
function isDate(d) {
  if (d.length !== 8) return false;
  const y = Number(d.slice(0, 4)), m = Number(d.slice(4, 6)), day = Number(d.slice(6));
  return y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && day >= 1 && day <= 31;
}

/** @param {string} text @returns {PiiSpan[]} */
export function detectPii(text) {
  /** @type {PiiSpan[]} */
  const spans = [];
  for (const r of RULES) {
    for (const m of text.matchAll(r.re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (spans.some((s) => start < s.end && end > s.start)) continue; // 앞선 규칙 우선
      const v = r.judge ? r.judge(m[0].replace(/\D/g, '')) : true;
      if (v === false) continue;
      spans.push({ type: r.type, start, end, certain: v === true });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** 확실·불확실 모두 마스킹한다 (불확실은 사람 검토에서 해제 가능). */
/** @param {string} text @param {PiiSpan[]} spans */
export function mask(text, spans) {
  let out = '';
  let p = 0;
  for (const s of spans) { out += text.slice(p, s.start) + LABEL[s.type]; p = s.end; }
  return out + text.slice(p);
}
