// PII 식별 정확도 측정 (사용자 확인 13항 4번, docs/03 ⑤). 정답 위치를 아는 합성 문장으로 재현율·오탐을 센다.
// 모든 값은 생성한 가상값이다 (실제 개인정보 아님). 고정 시드라 결과가 재현된다.
//   node apps/api/scripts/measure-pii.ts            # 규칙만
//   GUARDRAIL_ID=... node apps/api/scripts/measure-pii.ts   # 규칙 + Guardrails (설정 시)
import { detectPii, mask } from '@hanaeum/pii';
import { applyGuardrail } from '../src/aws.ts';

// PiiScan과 같은 순서: 규칙 마스킹 → (설정 시) Guardrails
const scan = async (t: string) => { const m = mask(t, detectPii(t)); return (await applyGuardrail(m))?.text ?? m; };
const mode = process.env.GUARDRAIL_ID ? `규칙 + Guardrails(${process.env.GUARDRAIL_ID}@${process.env.GUARDRAIL_VERSION ?? 'DRAFT'})` : '규칙만';

let seed = 20261116;
const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
const digits = (n: number) => Array.from({ length: n }, () => rnd(10)).join('');

function rrn() {
  const y = String(rnd(100)).padStart(2, '0'), m = String(1 + rnd(12)).padStart(2, '0'), d = String(1 + rnd(28)).padStart(2, '0');
  const body = `${y}${m}${d}${1 + rnd(4)}${digits(5)}`;
  const w = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  const c = (11 - (w.reduce((s, x, i) => s + x * Number(body[i]), 0) % 11)) % 10;
  return `${body.slice(0, 6)}-${body.slice(6)}${c}`;
}
function card() {
  const b = `4${digits(14)}`;
  let s = 0;
  for (let i = 0; i < 15; i++) { let n = Number(b[14 - i]); if (i % 2 === 0) { n *= 2; if (n > 9) n -= 9; } s += n; }
  const n = `${b}${(10 - (s % 10)) % 10}`;
  return `${n.slice(0, 4)}-${n.slice(4, 8)}-${n.slice(8, 12)}-${n.slice(12)}`;
}
const NAMES = ['김하나', '이서준', '박지민', '최유진', '정도윤'];
const STREETS = ['서울특별시 중구 을지로 35', '부산광역시 해운대구 센텀중앙로 97', '경기도 성남시 분당구 판교역로 166'];

type Case = { text: string; pii: { kind: string; value: string; rule: boolean }[] };
const T = (tpl: string, vals: Record<string, [string, string, boolean]>): Case => {
  let text = tpl;
  const pii: Case['pii'] = [];
  for (const [k, [kind, value, rule]] of Object.entries(vals)) { text = text.replace(`{${k}}`, value); pii.push({ kind, value, rule }); }
  return { text, pii };
};

const cases: Case[] = [];
for (let i = 0; i < 20; i++) {
  cases.push(T('차주 주민등록번호 {a}, 연락처 {b}로 서류 보완을 요청한다.', { a: ['주민등록번호', rrn(), true], b: ['휴대전화', `010-${digits(4)}-${digits(4)}`, true] }));
  cases.push(T('결제 카드 {a}의 한도 증액은 {b} 로 회신한다.', { a: ['카드번호', card(), true], b: ['이메일', `user${digits(3)}@example.com`, true] }));
  cases.push(T('입금 계좌번호: {a} (고객번호 {b})', { a: ['계좌번호(문맥)', `${digits(3)}-${digits(6)}-${digits(5)}`, true], b: ['고객번호', `C${digits(9)}`, true] }));
  cases.push(T('지점 대표번호 02-{a} 로 문의하고, 이체는 {b} 로 한다.', { a: ['유선전화', `${digits(4)}-${digits(4)}`, true], b: ['계좌번호(문맥 없음)', `${digits(4)}-${digits(2)}-${digits(6)}`, true] }));
  cases.push(T('고객 {a} 님의 주소 {b} 로 우편 통지한다.', { a: ['이름', NAMES[i % NAMES.length]!, false], b: ['주소', STREETS[i % STREETS.length]!, false] }));
}
// 유선전화 템플릿은 '02-' 접두가 값 밖에 있어 값 위치를 보정한다
for (const c of cases) for (const p of c.pii) if (p.kind === '유선전화') p.value = `02-${p.value}`;

// 개인정보가 아닌 금융 문서 표현 (오탐 대상)
const NEGATIVES = [
  '시행일 2026-11-01부터 적용한다.', '제12조제1항에 따라 5억원 이상은 본부 승인을 받는다.', '문서번호 HB-REG-LOAN-001, 개정 2026. 12. 1.',
  '고객센터 1588-1111로 안내한다.', '감정평가서 발급일로부터 6개월 이내', '금리 3.25%, 만기 2029-12-31', '여신 한도 1,000,000,000원',
  '심사 결과는 5년간 보관한다 (2026-11-16 기준).', '별표 3 서식 제2호', '외화 송금 USD 10,000 초과 시 신고',
];

function covered(text: string, value: string, masked: string) {
  // 값이 가려졌으면 마스킹본에 값이 남지 않는다
  return text.includes(value) && !masked.includes(value);
}

const byKind = new Map<string, { n: number; hit: number; rule: boolean }>();
for (const c of cases) {
  const m = await scan(c.text);
  for (const p of c.pii) {
    const k = byKind.get(p.kind) ?? { n: 0, hit: 0, rule: p.rule };
    k.n++; if (covered(c.text, p.value, m)) k.hit++;
    byKind.set(p.kind, k);
  }
}
let fp = 0;
const fpEx: string[] = [];
for (const t of NEGATIVES) { const m = await scan(t); if (m !== t) { fp++; fpEx.push(`${t} → ${m}`); } }

console.log(`모드: ${mode}`);
console.log('| 유형 | 규칙 대상 | 정답 수 | 가린 수 | 재현율 |\n|---|---|---|---|---|');
let rn = 0, rh = 0;
for (const [kind, k] of byKind) {
  console.log(`| ${kind} | ${k.rule ? '예' : '아니오 (Guardrails 필요)'} | ${k.n} | ${k.hit} | ${((k.hit / k.n) * 100).toFixed(0)}% |`);
  if (k.rule) { rn += k.n; rh += k.hit; }
}
console.log(`\n규칙 대상 재현율: ${rh}/${rn} (${((rh / rn) * 100).toFixed(1)}%) · 비개인정보 오탐: ${fp}/${NEGATIVES.length}`);
for (const e of fpEx) console.log(`  오탐: ${e}`);
