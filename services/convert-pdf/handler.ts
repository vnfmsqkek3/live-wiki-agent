// 단계 ConvertToPdf (사용자 결정 11/17 "모든 확장자를 PDF 로 먼저 변환한 뒤 전부 OCR", Owner yoyo0704).
// 순서: MalwareCheck → FileStructureCheck → ConvertToPdf → TextLayerExtract·PageRender → OcrIfNeeded(모든 쪽)
// 결과: {doc}/work/document.pdf. PageRender 가 이 파일의 모든 쪽을 렌더링한다(없으면 원본 PDF, 그것도 없으면 기존 방식).
//   PDF  : 그대로 복사            PNG·JPG: 이미지 1장 = 1쪽 (원본 픽셀 크기)
//   DOCX : LibreOffice headless   HWPX   : LibreOffice + H2Orestart. 실패하면 기존 방식(XML 글자)으로 계속 — 사용자 결정 "시험 통과 시만"
//   TXT·MD: 변환하지 않음(이미지가 없어 OCR 대상 없음)
// DOCX 변환 실패는 BLOCKED + 올린 사람이 읽을 수 있는 사유. 매크로 실행·외부 링크 갱신은 registrymodifications.xcu 로 끈다.
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { PDFDocument } from "pdf-lib";

export type StepInput = { workflow_id: string; doc_id: string; version: number; bucket: string; prefix: string; actor: { sub: string; groups: string[] } };
export type Finding = { finding_id: string; step: string; severity: "LOW" | "MEDIUM" | "HIGH"; code: string; message: string; evidence_ref: string; user_message?: string; fix_hint?: string };
export type StepOutput = { status: "OK" | "REVIEW_REQUIRED" | "BLOCKED"; output_key?: string; findings?: Finding[] };

export const STEP = "ConvertToPdf";
export const MAX_PAGES = 300; // ponytail: OCR 시간·비용 상한. 넘으면 사람 검토(문서를 나눠 올리도록 안내)

export type Deps = {
  findOriginal: (bucket: string, doc_id: string) => Promise<string | undefined>;
  get: (bucket: string, key: string) => Promise<Uint8Array>;
  copy: (bucket: string, from: string, to: string) => Promise<void>;
  put: (bucket: string, key: string, body: Uint8Array) => Promise<void>;
  /** LibreOffice 변환. 실패하면 throw */
  office: (data: Uint8Array, ext: "docx" | "hwpx") => Promise<Uint8Array>;
  saveFindings: (doc_id: string, step: string, findings: Finding[]) => Promise<void>;
  newId: () => string;
};

export async function imageToPdf(data: Uint8Array, ext: "png" | "jpg" | "jpeg"): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const img = ext === "png" ? await pdf.embedPng(data) : await pdf.embedJpg(data);
  pdf.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  return pdf.save();
}

export async function pageCount(data: Uint8Array): Promise<number> {
  return (await PDFDocument.load(data, { ignoreEncryption: true, updateMetadata: false })).getPageCount();
}

export function makeHandler(d: Deps) {
  return async (e: StepInput): Promise<StepOutput> => {
    const key = await d.findOriginal(e.bucket, e.doc_id);
    if (!key) throw new Error(`OriginalNotFound: ${e.doc_id}`);
    const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
    const out = `${e.doc_id}/work/document.pdf`;
    const finding = (severity: Finding["severity"], code: string, message: string, user_message: string, fix_hint: string): Finding =>
      ({ finding_id: `fnd_${d.newId()}`, step: STEP, severity, code, message, evidence_ref: key, user_message, fix_hint });

    let pdf: Uint8Array | undefined;
    if (ext === "pdf") {
      await d.copy(e.bucket, key, out);
      pdf = await d.get(e.bucket, out);
    } else if (ext === "png" || ext === "jpg" || ext === "jpeg") {
      pdf = await imageToPdf(await d.get(e.bucket, key), ext);
      await d.put(e.bucket, out, pdf);
    } else if (ext === "docx" || ext === "hwpx") {
      try {
        pdf = await d.office(await d.get(e.bucket, key), ext);
      } catch (err) {
        console.warn(JSON.stringify({ step: STEP, doc_id: e.doc_id, ext, error: (err as Error).name, message: (err as Error).message.slice(0, 200) }));
        if (ext === "hwpx") { await d.saveFindings(e.doc_id, STEP, []); return { status: "OK" }; } // 기존 방식(XML 글자)으로 계속
        const f = finding("HIGH", "CONVERT_FAILED", "DOCX → PDF 변환 실패",
          "문서를 PDF 로 바꾸지 못해 글자 인식(OCR)을 할 수 없습니다. 파일이 손상됐거나 지원하지 않는 기능(암호·매크로 등)이 들어 있을 수 있습니다.",
          "원본 프로그램에서 'PDF로 저장'한 파일을 올리거나, 암호를 풀고 다시 저장해 올려 주세요.");
        await d.saveFindings(e.doc_id, STEP, [f]);
        return { status: "BLOCKED", findings: [f] };
      }
      await d.put(e.bucket, out, pdf);
    } else {
      await d.saveFindings(e.doc_id, STEP, []);
      return { status: "OK" }; // txt·md 등: 변환 대상 아님
    }

    const pages = await pageCount(pdf).catch(() => 0); // 깨진 PDF(변환 산출물 손상·원본 PDF 손상)도 0쪽으로 → 차단 사유
    const findings: Finding[] = [];
    if (pages === 0) findings.push(finding("HIGH", "CONVERT_EMPTY", "변환 결과를 PDF 로 읽을 수 없음(0쪽)", "변환한 문서를 열 수 없거나 쪽이 없습니다.", "원본 파일을 열어 내용이 있는지 확인하고, 원본 프로그램에서 'PDF로 저장'해 다시 올려 주세요."))
    else if (pages > MAX_PAGES) findings.push(finding("MEDIUM", "TOO_MANY_PAGES", `변환 결과 ${pages}쪽 > ${MAX_PAGES}`,
      `문서가 ${pages}쪽이라 글자 인식에 시간이 오래 걸립니다. 검토자가 확인한 뒤 진행합니다.`, `${MAX_PAGES}쪽 이하로 나눠 올리면 바로 처리됩니다.`));
    await d.saveFindings(e.doc_id, STEP, findings);
    const status = findings.some((f) => f.severity === "HIGH") ? "BLOCKED" : findings.length ? "REVIEW_REQUIRED" : "OK";
    return { status, output_key: out, ...(findings.length ? { findings } : {}) };
  };
}

// ---------- LibreOffice 실행 ----------
const run = promisify(execFile);
const PROFILE = "/tmp/lo-profile";

export async function libreOffice(data: Uint8Array, ext: "docx" | "hwpx"): Promise<Uint8Array> {
  const dir = `/tmp/convert-${Date.now()}`;
  await mkdir(`${PROFILE}/user`, { recursive: true });
  await copyFile(new URL("./registrymodifications.xcu", import.meta.url), `${PROFILE}/user/registrymodifications.xcu`);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(`${dir}/in.${ext}`, data);
    const r = await run("soffice", ["--headless", "--norestore", "--nolockcheck", "--nodefault", `-env:UserInstallation=file://${PROFILE}`,
      "--convert-to", "pdf", "--outdir", dir, `${dir}/in.${ext}`], { timeout: 300_000, env: { ...process.env, HOME: "/tmp" } });
    try { return new Uint8Array(await readFile(`${dir}/in.pdf`)); }
    catch {
      // soffice 는 필터가 없거나 열지 못해도 종료 코드 0 → 출력으로 원인 남김 (11/17 HWPX 실측: 산출물 없음)
      throw new Error(`NoOutput: ${(r.stdout + " | " + r.stderr).replace(/\s+/g, " ").slice(0, 300)}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
