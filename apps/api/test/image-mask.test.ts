// 13항: 그림 페이지의 글자 개인정보 bbox 가림, OCR 없는 그림 페이지는 모델 입력 이미지 미생성
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { blackout, piiBoxes } from '../src/steps/image-mask.ts';
import { makePiiScan, type SegmentDeps } from '../src/lambdas.ts';
import { memoryStore } from '../src/store.ts';
import { newId, type DocumentRecord } from '../src/contracts.ts';

const white = (w: number, h: number) => { const p = new PNG({ width: w, height: h }); p.data.fill(255); return new Uint8Array(PNG.sync.write(p)); };
const px = (png: Uint8Array, x: number, y: number) => { const i = PNG.sync.read(Buffer.from(png)); const k = (y * i.width + x) * 4; return [...i.data.subarray(k, k + 3)]; };

test('개인정보 블록만 검게, OCR 좌표 비율 보정', async () => {
  const page = { page_index: 0, width: 100, height: 100, blocks: [{ text: '연락처 010-1234-5678', bbox: [10, 10, 40, 20] as [number, number, number, number] }, { text: '감정평가서 확인', bbox: [10, 60, 40, 70] as [number, number, number, number] }] };
  const boxes = await piiBoxes(page);
  assert.equal(boxes.length, 1);
  const out = blackout(white(200, 200), boxes, page); // 렌더가 OCR 좌표의 2배
  assert.deepEqual(px(out, 50, 30), [0, 0, 0]);
  assert.deepEqual(px(out, 50, 130), [255, 255, 255]);
});

test('PiiScan: 그림 페이지는 masked/pages 생성 + PII_IMAGE_REVIEW, OCR 없는 그림 페이지는 이미지 미생성', async () => {
  const store = memoryStore();
  const doc_id = newId.doc();
  const files = new Map<string, unknown>([
    [`${doc_id}/work/segments/0000.json`, { page_index: 0, text: '본문' }],
    [`${doc_id}/work/segments/0001.json`, { page_index: 1, text: '본문2' }],
    [`${doc_id}/work/pages/ocr_targets.json`, { pages: [{ page_index: 0, reason: 'image' }, { page_index: 1, reason: 'low_text', has_images: true }] }],
    [`${doc_id}/work/ocr/result.json`, { pages: [{ page_index: 0, width: 50, height: 50, blocks: [{ text: '010-1234-5678', bbox: [0, 0, 10, 10] }] }] }],
  ]);
  const bytes = new Map<string, Uint8Array>([[`${doc_id}/work/pages/0000.png`, white(50, 50)]]);
  const deps: SegmentDeps = {
    store, listKeys: async (p) => [...files.keys()].filter((k) => k.startsWith(p)).sort(), getJson: async <T,>(k: string) => { if (!files.has(k)) throw new Error('NoSuchKey'); return files.get(k) as T; },
    putJson: async (k, v) => { files.set(k, v); }, getBytes: async (k) => bytes.get(k)!, putBytes: async (k, b) => { bytes.set(k, b); },
  };
  const doc: DocumentRecord = { doc_id, version: 1, owner: 'u', title: 't', dept: 'd', acl_groups: ['ALL'], ext: 'pdf', lifecycle: 'QUARANTINED', authority_status: 'UNVERIFIED', freshness: 'CURRENT', findings: [], created_at: '', updated_at: '' };
  await store.putDoc(doc);
  const r = await makePiiScan(deps)({ workflow_id: 'w', doc_id, version: 1, bucket: 'b', prefix: 'p', actor: { sub: 'u', groups: [] } });
  assert.equal(r.status, 'REVIEW_REQUIRED');
  assert.ok(bytes.has(`${doc_id}/masked/pages/0000.png`));
  assert.ok(!bytes.has(`${doc_id}/masked/pages/0001.png`));
  assert.deepEqual(px(bytes.get(`${doc_id}/masked/pages/0000.png`)!, 5, 5), [0, 0, 0]);
  assert.equal(r.findings?.filter((f) => f.code === 'PII_IMAGE_REVIEW').length, 2);
});

test('그림 속 이름·주소: Guardrails가 가린 줄의 블록도 검게, 줄 수가 바뀌면 페이지 전체', async () => {
  const page = { page_index: 0, width: 100, height: 100, blocks: [{ text: '담당 김하나', bbox: [0, 0, 10, 10] as [number, number, number, number] }, { text: '감정평가서', bbox: [0, 20, 10, 30] as [number, number, number, number] }] };
  const g = async (t: string) => ({ text: t.replace('김하나', '{NAME}') });
  assert.deepEqual(await piiBoxes(page, g), [[0, 0, 10, 10]]);
  assert.deepEqual(await piiBoxes(page, async () => ({ text: 'x' })), [[0, 0, 100, 100]]);
});
