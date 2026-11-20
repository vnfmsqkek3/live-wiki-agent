import { test } from 'node:test';
import assert from 'node:assert/strict';
import { label } from '../src/steps/trust-gate.ts';

test('조문 표기: 가지번호 2단·3단', () => {
  assert.equal(label('ARTICLE:12/PARAGRAPH:1'), '제12조제1항');
  assert.equal(label('ARTICLE:7-2'), '제7조의2');
  assert.equal(label('ARTICLE:2-1-2/PARAGRAPH:1/ITEM:3'), '제2-1조의2제1항제3호');
});
