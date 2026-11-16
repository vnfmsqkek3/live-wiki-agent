// 개인정보 탐지·마스킹 순수 함수 (의존성 없음). API 단계 6과 Agent 질의 검사가 함께 쓴다.
export type PiiType = 'RRN' | 'PHONE' | 'EMAIL' | 'CARD' | 'ACCOUNT' | 'CUSTOMER_NO';

/** 화면·Finding 메시지용 한글 이름 */
export const PII_NAME: Record<PiiType, string> = { RRN: '주민등록번호', PHONE: '전화번호', EMAIL: '이메일', CARD: '카드번호', ACCOUNT: '계좌번호', CUSTOMER_NO: '고객번호' };

export interface PiiSpan {
  type: PiiType;
  start: number;
  end: number;
  certain: boolean; // false → 사람 검토
}

const LABEL: Record<PiiType, string> = {
  RRN: '[주민등록번호]',
  PHONE: '[전화번호]',
  EMAIL: '[이메일]',
  CARD: '[카드번호]',
  ACCOUNT: '[계좌번호]',
  CUSTOMER_NO: '[고객번호]',
};

/** 주민등록번호(외국인등록번호 포함) 체크섬. 2020-10 이후 발급분은 체크섬이 없어 실패할 수 있다. */
export function rrnChecksumOk(d: string) {
  const w = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  const sum = w.reduce((s, x, i) => s + x * Number(d[i]), 0);
  return (11 - (sum % 11)) % 10 === Number(d[12]);
}

function rrnDateOk(d: string) {
  const mm = Number(d.slice(2, 4));
  const dd = Number(d.slice(4, 6));
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && '12345678'.includes(d[6]!);
}

export function luhnOk(d: string) {
  let s = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    s += n;
  }
  return s % 10 === 0;
}

const RULES: { type: PiiType; re: RegExp; judge?: (digits: string) => boolean | 'uncertain' }[] = [
  {
    type: 'RRN',
    re: /(?<!\d)\d{6}\s?-?\s?[1-8]\d{6}(?!\d)/g,
    judge: (d) => (!rrnDateOk(d) ? false : rrnChecksumOk(d) ? true : 'uncertain'),
  },
  { type: 'CARD', re: /(?<!\d)\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}(?!\d)/g, judge: (d) => luhnOk(d) || 'uncertain' },
  { type: 'PHONE', re: /(?<!\d)01[016789][- .]?\d{3,4}[- .]?\d{4}(?!\d)/g },
  { type: 'PHONE', re: /(?<!\d)0(2|[3-6][1-5])[- .]?\d{3,4}[- .]?\d{4}(?!\d)/g },
  { type: 'EMAIL', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  // 금융 사전: "계좌", "고객번호" 문맥 뒤 숫자열
  { type: 'ACCOUNT', re: /(?<=계좌\s*(번호)?\s*[:：]?\s*)\d[\d-]{8,18}\d/g },
  { type: 'CUSTOMER_NO', re: /(?<=고객\s*(번호|ID)\s*[:：]?\s*)[A-Z]{0,3}\d{6,12}/g },
  // 문맥 없는 계좌 형태(3-2~6-2~8) → 불확실
  { type: 'ACCOUNT', re: /(?<!\d)\d{3,6}-\d{2,6}-\d{2,8}(?!\d)/g, judge: (d) => (isDate(d) ? false : 'uncertain') },
];

/** YYYYMMDD 형태의 실제 날짜 (시행일 2026-11-01 등을 계좌로 오탐하지 않도록) */
function isDate(d: string) {
  if (d.length !== 8) return false;
  const y = Number(d.slice(0, 4)), m = Number(d.slice(4, 6)), day = Number(d.slice(6));
  return y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && day >= 1 && day <= 31;
}

export function detectPii(text: string): PiiSpan[] {
  const spans: PiiSpan[] = [];
  for (const r of RULES) {
    for (const m of text.matchAll(r.re)) {
      const start = m.index!;
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
export function mask(text: string, spans: PiiSpan[]) {
  let out = '';
  let p = 0;
  for (const s of spans) { out += text.slice(p, s.start) + LABEL[s.type]; p = s.end; }
  return out + text.slice(p);
}
