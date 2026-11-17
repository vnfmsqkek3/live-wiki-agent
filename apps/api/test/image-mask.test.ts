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

test('그림 블록: Guardrail이 찾은 값이 든 블록도 검게', async () => {
  const page = { page_index: 0, width: 100, height: 100, blocks: [{ text: 'PW: hunter2!', bbox: [0, 0, 10, 10] as [number, number, number, number] }, { text: '감정평가서', bbox: [0, 20, 10, 30] as [number, number, number, number] }] };
  const g = async (t: string) => ({ text: t, entities: [{ type: 'PASSWORD', match: 'hunter2!' }] });
  assert.deepEqual(await piiBoxes(page, g), [[0, 0, 10, 10]]);
});

test('PiiScan 그림 쪽 기준: OCR figures가 있으면 그 개수로, 없으면(이전 OCR) has_images·image', async () => {
  const { makePiiScan } = await import('../src/lambdas.ts');
  const { memoryStore } = await import('../src/store.ts');
  const store = memoryStore();
  const doc_id = 'doc_fig';
  const now = new Date().toISOString();
  await store.putDoc({ doc_id, version: 1, owner: 'u', title: 't', dept: 'd', acl_groups: ['ALL'], ext: 'pdf', lifecycle: 'QUARANTINED', authority_status: 'UNVERIFIED', freshness: 'CURRENT', findings: [], created_at: now, updated_at: now } as never);
  const blk = { text: '본문', bbox: [0, 0, 10, 10] };
  const objs = new Map<string, unknown>([
    [`${doc_id}/work/segments/0000.json`, { doc_id, page_index: 0, text: '본문' }],
    [`${doc_id}/work/segments/0001.json`, { doc_id, page_index: 1, text: '본문' }],
    [`${doc_id}/work/pages/ocr_targets.json`, { pages: [{ page_index: 0, reason: 'all', has_images: true }, { page_index: 1, reason: 'all' }] }],
    [`${doc_id}/work/ocr/result.json`, { pages: [
      { page_index: 0, width: 10, height: 10, blocks: [blk], figures: [] }, // 표·글자만 → 제외 (has_images여도)
      { page_index: 1, width: 10, height: 10, blocks: [blk], figures: [{ label: 'seal', bbox: [0, 0, 5, 5] }] }, // 도장 → 대상
    ] }],
  ]);
  const put: string[] = [];
  const png = (await import('pngjs')).PNG;
  const img = png.sync.write(new png({ width: 10, height: 10 }));
  const scan = makePiiScan({
    store, listKeys: async (pre) => [...objs.keys()].filter((k) => k.startsWith(pre)), getJson: async <T>(k: string) => { if (!objs.has(k)) throw new Error('nf'); return objs.get(k) as T; },
    putJson: async (k, v) => { objs.set(k, v); }, getBytes: async () => new Uint8Array(img), putBytes: async (k) => { put.push(k); },
  });
  const r = await scan({ doc_id, workflow_id: 'wf' } as never);
  assert.deepEqual(put, [`${doc_id}/masked/pages/0001.png`]);
  assert.equal(r.findings?.filter((f) => f.code === 'PII_IMAGE_REVIEW').length, 1);
});

test('piiBoxes: Guardrail IP·사용자명 판정으로는 칠하지 않고, IP는 규칙으로 칠한다', async () => {
  const page = { page_index: 0, width: 100, height: 100, blocks: [
    { text: 'SINDORICOH', bbox: [0, 0, 10, 10] as [number, number, number, number] },
    { text: '10.20.30.41', bbox: [0, 20, 10, 30] as [number, number, number, number] },
  ] };
  const g = async () => ({ text: '', entities: [{ type: 'USERNAME', match: 'SINDORICOH' }, { type: 'IP_ADDRESS', match: '10.20.30.41' }] });
  assert.deepEqual(await piiBoxes(page as never, g), [[0, 20, 10, 30]]);
});
