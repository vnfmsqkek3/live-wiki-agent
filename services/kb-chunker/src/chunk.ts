// 청킹 로직 (순수 함수). docs/01 8.1~8.3, docs/04 6.4
// 법령: 항 = 기본 청크, 항 없는 조 = 조 전체, 긴 항은 호 경계에서 분할. 부칙 조·별표는 독립 청크.
// 노하우·매뉴얼: Markdown 제목(##) 단위, 없으면 문서 전체.
// 임베딩 입력(contentBody) = augmented_search_text = 문맥 헤더 + 실제 본문. original_text는 인용용으로 메타데이터에 분리.
import { parseLaw } from "@hanaeum/legal-parser";
import { FIGURE_RE, isoOfYmd } from "@hanaeum/schemas";
import type { DocumentMetadata, Provision, ProvisionStatus } from "@hanaeum/schemas";

export interface Chunk {
  augmented_search_text: string; // = KB contentBody (임베딩·BM25 대상)
  metadata: DocumentMetadata & {
    provision_id: string; provision_path: string; provision_status: ProvisionStatus;
    parent_id: string; source_page: number; original_text: string;
    has_figure?: boolean; // 그림 묘사 청크 (인용 불가)
  };
}

// ponytail: 글자 수 근사. Titan V2 한도(8k 토큰)보다 충분히 작게 잡음. 실측 후 토크나이저 기준으로 교체
export const MAX_CHUNK_CHARS = 1800;

const fmtDate = isoOfYmd;

/** 노드 + 하위 노드 원문을 순서대로 이어붙임 (마커 포함) */
function subtree(p: Provision, children: Map<string, Provision[]>): Provision[] {
  return [p, ...(children.get(p.provision_id) ?? []).flatMap((c) => subtree(c, children))];
}
const render = (nodes: Provision[], field: "original_text" | "normalized_text") =>
  nodes.map((n) => (n.level === "ARTICLE" ? `${n.original_marker}${n.title ? `(${n.title})` : ""} ` : `${n.original_marker} `) + n[field]).join("\n").trim();

/** pageOfLine: 입력 줄 번호(1부터) → 쪽(0부터). 없으면 0 (쪽 경계 없는 = 한 쪽 문서) */
export function chunkLegal(text: string, meta: DocumentMetadata, pageOfLine: (line: number) => number = () => 0): Chunk[] {
  if (!meta.law_id || !meta.revision_id) throw new Error("법령 청킹에는 law_id·revision_id 필요");
  const lawName = meta.law_name ?? meta.title;
  const law = parseLaw(text, { law_id: meta.law_id, law_name: lawName, revision_id: meta.revision_id });
  const byId = new Map(law.provisions.map((p) => [p.provision_id, p]));
  const children = new Map<string, Provision[]>();
  for (const p of law.provisions) if (p.parent_id) children.set(p.parent_id, [...(children.get(p.parent_id) ?? []), p]);

  // 청크 단위 선택
  const units: Provision[] = [];
  for (const p of law.provisions) {
    if (p.level === "ANNEX") units.push(p);
    if (p.level !== "ARTICLE") continue;
    const paras = (children.get(p.provision_id) ?? []).filter((c) => c.level === "PARAGRAPH");
    if (!paras.length) { units.push(p); continue; }
    for (const para of paras) {
      const nodes = subtree(para, children);
      if (render(nodes, "original_text").length <= MAX_CHUNK_CHARS) { units.push(para); continue; }
      // 긴 항: 항 본문 + 호 단위로 분할 (상위 항 문맥은 헤더로 연결)
      units.push(para);
      for (const item of (children.get(para.provision_id) ?? [])) units.push(item);
    }
  }

  const splitLong = new Set(units.filter((u) => u.level === "ITEM").map((u) => u.parent_id));
  return units.map((u) => {
    const article = u.level === "ARTICLE" ? u : [...ancestors(u, byId)].find((a) => a.level === "ARTICLE");
    const nodes = u.level === "PARAGRAPH" && splitLong.has(u.provision_id) ? [u] : subtree(u, children);
    const original = render(nodes, "original_text");
    const normalized = render(nodes, "normalized_text");
    const header = [
      lawName,
      `시행 ${fmtDate(meta.effective_from)}`,
      ...u.heading_path,
      article ? `${article.path_label}${article.title ? `(${article.title})` : ""}` : undefined,
      u.level !== "ARTICLE" ? u.path_label : undefined,
      u.status === "DELETED" ? "삭제됨" : undefined,
    ].filter(Boolean).join(" · ");
    return {
      augmented_search_text: `[${header}]\n${normalized}`,
      metadata: {
        ...meta,
        provision_id: u.provision_id,
        provision_path: u.path_label,
        provision_status: u.status,
        parent_id: u.parent_id ?? meta.doc_id,
        source_page: pageOfLine(u.source_line),
        original_text: original,
      },
    };
  });
}

function* ancestors(p: Provision, byId: Map<string, Provision>) {
  let cur = p.parent_id ? byId.get(p.parent_id) : undefined;
  while (cur) { yield cur; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined; }
}

export function chunkKnowledge(text: string, meta: DocumentMetadata, pageOfLine: (line: number) => number = () => 0): Chunk[] {
  const fm = /^---\n[\s\S]*?\n---\n/u.exec(text)?.[0] ?? "";
  const body = text.slice(fm.length); // front matter 제거
  const offset = fm ? fm.split("\n").length - 1 : 0;
  const sections: { heading: string; text: string; page: number }[] = [];
  let cur = { heading: meta.title, text: "", page: -1 };
  for (const [i, line] of body.split(/\r?\n/u).entries()) {
    const h = line.match(/^#{2,3}\s+(.+)$/u);
    if (h) { if (cur.text.trim()) sections.push(cur); cur = { heading: h[1]!.trim(), text: "", page: -1 }; continue; }
    if (/^#\s+/u.test(line)) continue; // 문서 제목은 헤더로
    if (cur.page < 0 && line.trim()) cur.page = pageOfLine(offset + i + 1); // 절의 첫 글자 줄이 있는 쪽
    cur.text += line + "\n";
  }
  if (cur.text.trim()) sections.push(cur);
  if (!sections.length) throw new Error("노하우 본문이 비어 있음");
  const kind = meta.document_type === "MANUAL" ? "매뉴얼" : "노하우";
  return sections.map((s, i) => {
    const t = s.text.trim();
    return {
      augmented_search_text: `[${meta.title} · ${kind} · ${s.heading}]\n${t}`,
      metadata: {
        ...meta, provision_id: `${meta.doc_id}#s${i}`, provision_path: s.heading, provision_status: "ACTIVE",
        parent_id: meta.doc_id, source_page: Math.max(0, s.page), original_text: t,
      },
    };
  });
}


/** 본문 끝의 그림 묘사 줄(⟦그림 pN⟧)은 본문 파싱에서 빼고 별도 청크로. original_text는 비워 인용 금지 (그림 묘사는 원문이 아님) */
export function chunkDocument(text: string, meta: DocumentMetadata): Chunk[] {
  const body: string[] = []; const figs: { page: number; text: string }[] = [];
  for (const line of text.split("\n")) { const m = FIGURE_RE.exec(line); if (m) figs.push({ page: Number(m[1]), text: m[2]! }); else body.push(line); }
  // 쪽 번호: Promote가 넣은 쪽 경계(\f 한 줄). \f만 지우고 줄 수는 그대로 두어, 조문·절이 시작하는 줄의 쪽을 쓴다
  // (반복되는 머리말·목차와 글자가 같아도 위치로 정하므로 앞쪽에 잘못 붙지 않음, PR #37 리뷰)
  const lines = body;
  const pageAt: number[] = [];
  let pg = 0;
  for (const l of lines) { pageAt.push(pg); if (l.includes("\f")) pg++; }
  const pageOfLine = (ln: number) => pageAt[Math.min(Math.max(ln - 1, 0), pageAt.length - 1)] ?? 0;
  const clean = lines.join("\n").replace(/\f/gu, "");
  const main = meta.document_type === "REGULATION" ? chunkLegal(clean, meta, pageOfLine) : chunkKnowledge(clean, meta, pageOfLine);
  return [...main, ...figs.map((f, i) => ({
    augmented_search_text: `[${meta.title} · 그림 (${f.page + 1}쪽)]\n${f.text}`,
    metadata: { ...meta, provision_id: `${meta.doc_id}#fig${i}`, provision_path: `그림 (${f.page + 1}쪽)`, provision_status: "ACTIVE" as const,
      parent_id: meta.doc_id, source_page: f.page, original_text: "", has_figure: true },
  }))];
}
