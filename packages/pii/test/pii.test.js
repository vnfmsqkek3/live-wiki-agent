// @ts-check
// 고유식별정보·식별값만 가린다. 이름·나이·주소는 그대로 (사용자 결정 11/17)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPii, mask } from '../index.js';

const m = (/** @type {string} */ t) => mask(t, detectPii(t));

test('고유식별정보: 외국인등록번호·여권번호(문맥)·운전면허번호', () => {
  assert.equal(m('외국인등록번호 900101-5123454'), '외국인등록번호 [외국인등록번호]');
  assert.equal(m('여권번호: M12345678, 여권 M123A4567'), '여권번호: [여권번호], 여권 [여권번호]');
  assert.equal(m('운전면허 11-12-123456-12 확인'), '운전면허 [운전면허번호] 확인');
  assert.equal(m('면허 서울 12-123456-12'), '면허 [운전면허번호]');
});

test('이름·나이·주소·날짜는 가리지 않음', () => {
  const t = '고객 홍길동(45세) 님, 서울특별시 중구 을지로 35, 시행일 2026-11-01';
  assert.equal(m(t), t);
});
