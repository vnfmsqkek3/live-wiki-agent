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
