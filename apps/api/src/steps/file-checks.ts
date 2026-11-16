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
    for (const [re, code] of [
      [/\/JavaScript\b|\/JS\s*[(<]/, 'PDF_JAVASCRIPT'],
      [/\/Launch\b/, 'PDF_LAUNCH'],
      [/\/EmbeddedFile\b/, 'PDF_EMBEDDED_FILE'],
      [/\/OpenAction\b|\/AA\b/, 'PDF_AUTO_ACTION'],
    ] as const)
      if (re.test(s)) add(code === 'PDF_AUTO_ACTION' ? 'MEDIUM' : 'HIGH', code, `PDF ${code}`, 'catalog');
  }
  if (kind === 'docx' || kind === 'hwpx') {
    const s = ascii(body);
    if (/vbaProject\.bin|activeX\//.test(s)) add('HIGH', 'OFFICE_MACRO', '매크로·스크립트 포함', 'zip');
  }
  const status = findings.some((x) => x.severity === 'HIGH') ? 'BLOCKED' : findings.length ? 'REVIEW_REQUIRED' : 'OK';
  return { status, findings };
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

function f(step: string, severity: Finding['severity'], code: string, message: string, evidence_ref: string): Finding {
  return { finding_id: newId.fnd(), step, severity, code, message, evidence_ref };
}
