const assert = require('node:assert/strict');
const Module = require('node:module');
const { test } = require('node:test');

const originalLoad = Module._load;
let extension;
try {
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  extension = require('../extension');
} finally {
  Module._load = originalLoad;
}

const { parseDelimited, detectDelimiter, findCell } = extension;

test('parses escaped quotes and multiline quoted fields', () => {
  const parsed = parseDelimited(
    'name,comment\r\n"Ada","said ""hello"""\r\n"Lin","first\nsecond"',
    ',',
    '"'
  );

  assert.deepEqual(parsed.rows.map(row => row.cells.map(cell => cell.value)), [
    ['name', 'comment'],
    ['Ada', 'said "hello"'],
    ['Lin', 'first\nsecond']
  ]);
  assert.deepEqual(parsed.errors, []);
});

test('parses quoted pipe-delimited records with 89 columns', () => {
  const fields = Array.from({ length: 89 }, (_, index) => `"field-${index}${index === 5 ? '|inside' : ''}"`);
  const parsed = parseDelimited(`${fields.join('|')}\n${fields.join('|')}`, '|', '"');

  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].cells.length, 89);
  assert.equal(parsed.rows[0].cells[5].value, 'field-5|inside');
  assert.equal(parsed.rows[1].cells[88].value, 'field-88');
  assert.deepEqual(parsed.errors, []);
});

test('merges runs of whitespace separators', () => {
  const parsed = parseDelimited('name   age\nAva\t\t32', 'whitespace', '"');

  assert.deepEqual(parsed.rows.map(row => row.cells.map(cell => cell.value)), [
    ['name', 'age'],
    ['Ava', '32']
  ]);
});

test('reports an unclosed quoted field', () => {
  const parsed = parseDelimited('name,note\nAda,"unfinished', ',', '"');

  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0].message, /Unclosed quoted field/);
});

test('detects a delimiter while ignoring separators inside quoted fields', () => {
  const text = 'name,note\nAda,"comma, inside"\nLin,"another, comma"';

  assert.equal(detectDelimiter(text, '"', 20, 2, []), ',');
});

test('detects pipe in quoted 89-column records', () => {
  const fields = Array.from({ length: 89 }, (_, index) => `"field-${index}${index === 5 ? '|inside' : ''}"`);
  const text = `${fields.join('|')}\n${fields.join('|')}`;

  assert.equal(detectDelimiter(text, '"', 20, 2, []), '|');
});

test('does not assign separator offsets to either adjacent cell', () => {
  const text = 'left::right';
  const parsed = parseDelimited(text, '::', '"');
  const document = { offsetAt: position => position.character };

  assert.equal(findCell(document, parsed, { line: 0, character: 0 }).columnIndex, 0);
  assert.equal(findCell(document, parsed, { line: 0, character: 4 }), undefined);
  assert.equal(findCell(document, parsed, { line: 0, character: 5 }), undefined);
  assert.equal(findCell(document, parsed, { line: 0, character: 6 }).columnIndex, 1);
});
