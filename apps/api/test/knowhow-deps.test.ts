// 실제 let522mj 패키지(조문 저장소 fixture·인용 추출)로 노하우 검증 의존성 확인
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureClauseStore } from '../../../mcp/regulation-server/src/fixtures.ts'; // 테스트 전용 fixture (패키지 exports 밖)
import { extractCitations } from '@hanaeum/graph-server';
import { clauseGetter, knowhowDeps, type ClauseStoreLike } from '../src/knowhow-deps.ts';

const store = fixtureClauseStore() as unknown as ClauseStoreLike;
const today = () => 20261116;

test('조문 조회: 현행 조문 원문·라벨, 개정 전 조문은 HISTORICAL + 같은 위치 현행 조문', async () => {
  const get = clauseGetter(store, today);
  const cur = await get('SYN-LOAN-001@2026-11-01/ARTICLE:12/PARAGRAPH:1');
  assert.equal(cur?.status, 'ACTIVE');
  assert.match(cur!.text, /5억원/);
  assert.match(cur!.label, /제12조제1항/);
  const old = await get('SYN-LOAN-001@2025-01-01/ARTICLE:12/PARAGRAPH:1');
  assert.equal(old?.status, 'HISTORICAL');
  assert.match(old!.text, /7억원/);
  assert.equal(old!.current?.provision_id, 'SYN-LOAN-001@2026-11-01/ARTICLE:12/PARAGRAPH:1');
  assert.equal(await get('SYN-LOAN-001@2026-11-01/ARTICLE:999'), undefined);
});

test('인용 추출(K-003 본문) → 개정 전 조문 인용 후보', async () => {
  const deps = knowhowDeps({
    store, extract: (t, s, asOf) => extractCitations(t, s as never, asOf), searchProvisionIds: async () => [],
    judge: async () => ({ items: [], model: 'm' }),
  });
  const c = await deps.extractCitations('여신 금액이 7억원 이상일 때만 본부 여신심사위원회 승인을 받는다 (기업여신 심사규정 2025. 1. 1. 시행본 제12조제1항).');
  assert.ok(c.some((x) => x.provision_id === 'SYN-LOAN-001@2025-01-01/ARTICLE:12/PARAGRAPH:1'), JSON.stringify(c));
});

test('더 새 VERIFIED 개정본(미래 시행): 현행이 아니어도 newer로 알려 주장 재검토에 쓴다 (let522mj 요청 11/17)', async () => {
  const { sameText } = await import('../src/claims.ts');
  const get = clauseGetter(store, () => 20251201); // 2026-11-01 개정본은 아직 시행 전
  const old = await get('SYN-LOAN-001@2025-01-01/ARTICLE:12/PARAGRAPH:1');
  assert.equal(old?.status, 'ACTIVE'); // 아직 현행
  assert.equal(old?.newer?.provision_id, 'SYN-LOAN-001@2026-12-01/ARTICLE:12/PARAGRAPH:1'); // 가장 새 VERIFIED 개정본과 비교
  assert.equal(sameText(old!.text, old!.newer!.text), false);
  assert.equal((await get('SYN-LOAN-001@2026-12-01/ARTICLE:12/PARAGRAPH:1'))?.newer, undefined);
  assert.equal(sameText('① 시재는 마감 전 확인한다.', '①시재는 마감 전 확인한다'), true);
});
