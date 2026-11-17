// Run: node --test apps/web/doc-text.test.mjs (no new dependencies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const file = new URL('./app/doc-text.tsx', import.meta.url);
const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled)(createRequire(file), mod, mod.exports);
const { DocText, parseDocText } = mod.exports;
const render = (text, marks = []) => renderToStaticMarkup(React.createElement(DocText, { text, marks, active: 1 }));
const visible = (html) => html.replace(/<sup>.*?<\/sup>/g, '').replace(/<[^>]+>/g, '');
test('source offsets survive CRLF, bold, masking, headings and multiline marks', () => {
  const text = '# 제목\r\n**굵게** [주민등록번호]\n> 인용';
  const html = render(text, [{ n: 1, m: { start: 2, end: text.length } }]);
  assert.equal(visible(html), '제목굵게 [주민등록번호]인용');
  assert.equal((html.match(/<sup>1<\/sup>/g) || []).length, 5);
  assert.match(html, /class="hl on"/);
  assert.match(html, /class="pii"/);
  assert.equal(parseDocText(text)[1].start, 6);
});
test('tables, isolated pipes, clauses and list content preserve characters once', () => {
  assert.equal(visible(render('|a|b|\n|c|d|')), 'abcd');
  assert.equal(visible(render('|a|b|')), '|a|b|');
  assert.equal(visible(render('제1조(목적)\n① 항목\n2) 다음\n- 끝')), '제1조(목적)①항목2)다음•끝');
});
test('overlap follows the earlier mark; literal HTML is escaped', () => {
  const html = render('abcdef', [{ n: 1, m: { start: 1, end: 4 } }, { n: 2, m: { start: 2, end: 6 } }]);
  assert.equal(visible(html), 'abcdef');
  assert.match(html, /bcd<sup>1/);
  assert.match(html, /ef<sup>2/);
  assert.match(render('<script>'), /&lt;script&gt;/);
});

test('long clauses separate their title and body without changing source marks', () => {
  const text = '제7조의2(중도 해지) ① 수수료는 계약서에 명시한다.\n제2장 업무 기준';
  const start = text.indexOf('해지');
  const html = render(text, [{ n: 1, m: { start, end: text.indexOf('계약서') + 3 } }]);
  assert.equal(visible(html), text.replace('\n', ''));
  assert.match(html, /id="clause-0"/);
  assert.match(html, /<\/h3><p>/);
  assert.match(html, /class="hl on"/);
  assert.equal(parseDocText(text)[1].start, text.indexOf('제2장'));
});

test('reflow: PDF에서 끊긴 문장은 잇고, 번호 소제목은 제목, → 흐름은 한 줄, 원문 위치는 그대로', () => {

  const text = '1.개인정보 처리 근거\n고객정보 수집 전에는 처리 목적과 적용 가능한 법적 근거를 확인한다.\n\n「개인정보 보호법」 제15조제1항: “개인정보처리자는 다음 각 호의 어느 하나에 해당하는 경우에는 개인정보를 수집할 수\n\n있으며 그 수집 목적의 범위에서 이용할 수 있다.”\n\n처리목적\n\n확인 → 법적근거\n\n확인 → 고객안내';
  const b = parseDocText(text).filter((x) => x.kind !== 'blank');
  assert.equal(b[0].kind, 'heading');
  const law = b.find((x) => text.slice(x.start, x.end).includes('「개인정보 보호법」'));
  assert.ok(law.flow && text.slice(law.start, law.end).endsWith('있다.”'));
  const flow = b.find((x) => text.slice(x.start, x.end).startsWith('처리목적'));
  assert.ok(text.slice(flow.start, flow.end).endsWith('고객안내'));
  assert.equal(b.find((x) => text.slice(x.start, x.end).startsWith('고객정보')).flow, undefined);
});
