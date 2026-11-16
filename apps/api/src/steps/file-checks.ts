// 단계 0 type-detection, 단계 2 FileStructureCheck. 순수 함수 (S3 읽기는 호출자가 담당).
import { newId, type Finding, type StepOutput } from '../contracts.ts';
import { INJECTION_RULES } from './injection.ts';

export type FileKind = 'pdf' | 'docx' | 'hwpx' | 'png' | 'jpg';

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((v, i) => b[i] === v);
const ascii = (b: Uint8Array) => Buffer.from(b).toString('latin1');

/** 매직바이트로 실제 형식을 판정한다. 허용 형식이 아니면 undefined. */
export function detectKind(head: Uint8Array): FileKind | undefined {
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf';
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpg';
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    // ponytail: ZIP 내부를 풀지 않고 앞부분 파일명으로 판정. 오판 사례가 나오면 zip 목록 파싱으로 교체
    const s = ascii(head.subarray(0, 8192));
    if (s.includes('application/hwp+zip')) return 'hwpx';
    if (s.includes('word/') || s.includes('[Content_Types].xml')) return 'docx';
  }
  return undefined;
}

export function typeDetection(ext: string, head: Uint8Array): StepOutput & { kind?: FileKind } {
  const e = ext.toLowerCase() === 'jpeg' ? 'jpg' : ext.toLowerCase();
  const kind = detectKind(head);
  if (!kind) return { status: 'BLOCKED', findings: [f('TYPE_DETECTION', 'HIGH', 'UNSUPPORTED_TYPE', '허용되지 않은 파일 형식', 'header')] };
  if (kind !== e) return { status: 'BLOCKED', kind, findings: [f('TYPE_DETECTION', 'HIGH', 'EXT_MISMATCH', `확장자(${e})와 실제 형식(${kind}) 불일치`, 'header')] };
  return { status: 'OK', kind, findings: [] };
}

/** 메타데이터·임베디드 스크립트·후행 데이터 검사 (A-002). */
export function fileStructureCheck(kind: FileKind, body: Uint8Array): StepOutput {
  const findings: Finding[] = [];
  const add = (sev: Finding['severity'], code: string, msg: string, ref: string) =>
    findings.push(f('FILE_STRUCTURE', sev, code, msg, ref));

  if (kind === 'png') {
    for (const c of pngChunks(body)) {
      if (c.type === 'tEXt' || c.type === 'iTXt' || c.type === 'zTXt') {
        const text = ascii(c.data);
        if (INJECTION_RULES.some((r) => r.re.test(text)) || /<script|javascript:/i.test(text))
          add('HIGH', 'PNG_METADATA_INJECTION', `PNG ${c.type} 청크에 명령형·스크립트 텍스트`, `chunk@${c.offset}`);
        else if (c.data.length > 4096) add('MEDIUM', 'PNG_LARGE_METADATA', `PNG ${c.type} 청크 ${c.data.length}B`, `chunk@${c.offset}`);
      }
      if (c.type === 'IEND' && body.length > c.end) add('HIGH', 'TRAILING_DATA', `IEND 뒤 ${body.length - c.end}B`, `offset@${c.end}`);
    }
  }
  if (kind === 'jpg') {
    const s = ascii(body);
    if (INJECTION_RULES.some((r) => r.re.test(s)) || /<script|javascript:/i.test(s))
      add('HIGH', 'JPG_METADATA_INJECTION', 'JPEG 메타데이터에 명령형·스크립트 텍스트', 'segments');
  }
  if (kind === 'pdf') {
    const s = ascii(body);
    if (/\/EmbeddedFile\b/.test(s)) {
      const files = pdfEmbedded(s);
      const list = files.slice(0, 3).map((x) => x.name).join(', ') + (files.length > 3 ? ` 외 ${files.length - 3}개` : '');
      const onlyC2pa = files.length > 0 && files.every((x) => x.c2pa);
      findings.push(f('FILE_STRUCTURE', 'HIGH', 'PDF_EMBEDDED_FILE', `PDF 첨부 파일 ${files.length}개`, 'catalog', {
        user_message: onlyC2pa
          ? `PDF 안에 콘텐츠 출처 서명(C2PA, ${list})이 첨부되어 있습니다. 문서 작성 도구가 자동으로 넣는 경우가 많지만, 첨부 파일은 보안상 등록할 수 없습니다.`
          : `PDF 안에 첨부 파일 ${files.length}개(${list})가 들어 있어 보안상 등록할 수 없습니다.`,
        fix_hint: `첨부 파일을 지운 뒤 ${FIX_PDF}`,
        details: { embedded_files: files.slice(0, 10) },
      }));
    }
    for (const [re, code, sev, what] of [
      [/\/JavaScript\b|\/JS\s*[(<]/, 'PDF_JAVASCRIPT', 'HIGH', '스크립트(JavaScript)'],
      [/\/Launch\b/, 'PDF_LAUNCH', 'HIGH', '다른 프로그램 실행 동작(Launch)'],
      [/\/OpenAction\b|\/AA\b/, 'PDF_AUTO_ACTION', 'MEDIUM', '열 때 자동으로 실행되는 동작(OpenAction)'],
    ] as const) {
      if (!re.test(s)) continue;
      const objs = pdfObjects(s, re);
      findings.push(f('FILE_STRUCTURE', sev, code, `PDF ${code}`, objs.length ? `obj:${objs.join(',')}` : 'catalog', {
        details: { objects: objs }, // ponytail: 쪽 번호는 페이지 트리 해석이 필요해 비움. 필요하면 pdfjs로 Annots·AA를 쪽에 대응
        user_message: `PDF 안에 ${what}이 들어 있습니다${objs.length ? ` (내부 객체 ${objs.join(', ')}번)` : ''}.${sev === 'HIGH' ? ' 보안상 등록할 수 없습니다.' : ' 관리자가 확인합니다.'}`,
        fix_hint: FIX_PDF,
      }));
    }
  }
  if (kind === 'docx' || kind === 'hwpx') {
    const s = ascii(body);
    const macro = [...new Set([...s.matchAll(/[\w/]*(?:vbaProject\.bin|activeX\/[\w.]+)/g)].map((m) => m[0]))].slice(0, 3);
    if (macro.length) findings.push(f('FILE_STRUCTURE', 'HIGH', 'OFFICE_MACRO', '매크로·스크립트 포함', 'zip', {
      user_message: `문서 안에 매크로·ActiveX(${macro.join(', ')})가 들어 있어 보안상 등록할 수 없습니다.`,
      fix_hint: kind === 'docx' ? "Word에서 '다른 이름으로 저장 → Word 문서(*.docx)'로 매크로 없이 저장해 다시 올려 주세요." : '한글에서 매크로를 지우고 다시 저장해 올려 주세요.',
    }));
    const z = zipSizes(body);
    if (!z) findings.push(f('FILE_STRUCTURE', 'HIGH', 'ZIP_INVALID', 'ZIP 목록(central directory)을 읽을 수 없음', 'zip', {
      user_message: '파일 구조가 손상되어 열 수 없습니다.', fix_hint: '원본 프로그램에서 파일을 다시 저장해 올려 주세요.',
    }));
    else if (z.total > ZIP_MAX_TOTAL || z.maxRatio > ZIP_MAX_RATIO)
      findings.push(f('FILE_STRUCTURE', 'HIGH', 'ZIP_BOMB', `압축 해제 크기 ${Math.round(z.total / 2 ** 20)}MB, 최대 압축률 ${Math.round(z.maxRatio)}배 (기준 ${ZIP_MAX_TOTAL / 2 ** 20}MB·${ZIP_MAX_RATIO}배)`, 'zip', {
        user_message: `압축을 풀면 ${Math.round(z.total / 2 ** 20)}MB로 지나치게 커지는 파일이라 등록할 수 없습니다.`,
        fix_hint: '문서 안의 큰 그림·첨부를 줄이거나 빼고 다시 저장해 올려 주세요.',
      }));
  }
  const status = findings.some((x) => x.severity === 'HIGH') ? 'BLOCKED' : findings.length ? 'REVIEW_REQUIRED' : 'OK';
  return { status, findings };
}

// 압축 폭탄 차단: 본문 추출(3a)이 압축을 풀기 전에 ZIP 목록의 크기만 본다
const ZIP_MAX_TOTAL = 200 * 2 ** 20; // ponytail: 50MB 업로드 기준 여유값. 정상 대형 문서가 걸리면 조정
const ZIP_MAX_RATIO = 100;
export function zipSizes(b: Uint8Array): { total: number; maxRatio: number } | undefined {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65_535); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return undefined;
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  let total = 0, maxRatio = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || dv.getUint32(p, true) !== 0x02014b50) return undefined;
    const comp = dv.getUint32(p + 20, true), raw = dv.getUint32(p + 24, true);
    total += raw;
    if (raw > 1_048_576) maxRatio = Math.max(maxRatio, raw / Math.max(comp, 1)); // 작은 파일의 높은 압축률은 정상
    p += 46 + dv.getUint16(p + 28, true) + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return { total, maxRatio };
}

function* pngChunks(b: Uint8Array) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8;
  while (p + 12 <= b.length) {
    const len = dv.getUint32(p);
    const type = ascii(b.subarray(p + 4, p + 8));
    const end = p + 12 + len;
    if (end > b.length) return;
    yield { type, data: b.subarray(p + 8, p + 8 + len), offset: p, end };
    if (type === 'IEND') return;
    p = end;
  }
}

function f(step: string, severity: Finding['severity'], code: string, message: string, evidence_ref: string, extra: Pick<Finding, 'user_message' | 'fix_hint' | 'location' | 'details'> = {}): Finding {
  return { finding_id: newId.fnd(), step, severity, code, message, evidence_ref, ...extra };
}

/** PDF 문자열 리터럴 (…) → 표시용. UTF-16BE(BOM)이면 디코드 */
function pdfString(raw: string) {
  const s = raw.replace(/\\([()\\])/g, '$1');
  if (s.startsWith('\u00fe\u00ff')) { let o = ''; for (let i = 2; i + 1 < s.length; i += 2) o += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1)); return o; }
  return Buffer.from(s, 'latin1').toString('utf8');
}
/** PDF 첨부 파일 이름들 (Filespec의 /UF 또는 /F) */
export function pdfAttachments(s: string): string[] { return pdfEmbedded(s).map((e) => e.name); }

/** PDF 첨부 사실: 이름(/UF·/F), 형식(/Subtype), 크기(/Params /Size 또는 /Length). C2PA(콘텐츠 출처 서명)는 표시 */
export function pdfEmbedded(s: string): { name: string; subtype?: string; size?: number; c2pa?: boolean }[] {
  const objDict = (n: string) => { const m = new RegExp(`(?:^|\\s)${n}\\s+0\\s+obj\\b([\\s\\S]{0,1500}?)(?:stream|endobj)`).exec(s); return m?.[1] ?? ''; };
  const out: { name: string; subtype?: string; size?: number; c2pa?: boolean }[] = [];
  for (const m of s.matchAll(/\/Type\s*\/Filespec([\s\S]{0,800}?)(?:>>\s*endobj|endobj)/g)) {
    const spec = m[1]!;
    const nm = /\/(?:UF|F)\s*\(((?:\\.|[^\\)]){1,200})\)/.exec(spec);
    const ef = /\/EF\s*<<[\s\S]*?\/(?:UF|F)\s+(\d+)\s+0\s+R/.exec(spec);
    const dict = ef ? objDict(ef[1]!) : '';
    const subtype = /\/Subtype\s*\/([^\s/<>\[\]()]+)/.exec(dict)?.[1]?.replace(/#2F/gi, '/');
    const size = Number(/\/Size\s+(\d+)/.exec(dict)?.[1] ?? /\/Length\s+(\d+)/.exec(dict)?.[1] ?? NaN);
    const name = nm ? pdfString(nm[1]!) : '이름 없는 첨부';
    const c2pa = /c2pa|content credentials/i.test(`${name} ${subtype ?? ''} ${/\/AFRelationship\s*\/(\w+)/.exec(spec)?.[1] ?? ''}`) || /c2pa/i.test(dict);
    out.push({ name, ...(subtype ? { subtype } : {}), ...(Number.isFinite(size) ? { size } : {}), ...(c2pa ? { c2pa: true } : {}) });
  }
  if (out.length) return out;
  return Array.from({ length: (s.match(/\/Type\s*\/EmbeddedFile\b/g) ?? []).length }, () => ({ name: '이름 없는 첨부' }));
}
/** 패턴이 들어 있는 PDF 객체 번호들 */
export function pdfObjects(s: string, re: RegExp): number[] {
  const out = new Set<number>();
  for (const m of s.matchAll(new RegExp(re.source, 'g'))) {
    const before = s.slice(Math.max(0, m.index! - 20000), m.index!);
    const objs = [...before.matchAll(/(\d+)\s+\d+\s+obj\b/g)];
    if (objs.length) out.add(Number(objs.at(-1)![1]));
  }
  return [...out].slice(0, 5);
}
const FIX_PDF = "Acrobat 등에서 '인쇄 → PDF로 저장'(또는 '다른 이름으로 저장 → 최적화된 PDF')으로 새로 만든 PDF를 올려 주세요.";
