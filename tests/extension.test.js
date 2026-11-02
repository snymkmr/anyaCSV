const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const originalLoad = Module._load;
const vscodeMock = {
  Range: class Range {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  },
  workspace: {
    getConfiguration: () => ({ get: (_key, fallback) => fallback })
  }
};
let extension;
try {
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscodeMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  extension = require('../extension');
} finally {
  Module._load = originalLoad;
}

const { parseDelimited, detectDelimiter, findCell, getFilteredTablePreviewRows, buildLargeCsvTablePreview, refreshTablePreview, updateDecorations } = extension;

function createPreviewFixture(source) {
  let text = source;
  let html = 'last-good-table';
  const messages = [];
  const uri = { fsPath: '/tmp/preview.csv', toString: () => 'file:///tmp/preview.csv' };
  const document = {
    uri,
    languageId: 'csv',
    version: 1,
    getText: () => text,
    setText: value => {
      text = value;
      document.version += 1;
    }
  };
  const webview = { postMessage: async message => messages.push(message) };
  Object.defineProperty(webview, 'html', { get: () => html, set: value => { html = value; } });
  const context = {
    previewPanels: new Map([[uri.toString(), { webview }]]),
    previewDelimiters: new Map([[uri.toString(), {
      delimiter: ',',
      autoDetected: true,
      recognized: true,
      version: 0
    }]]),
    previewDelimiterVersion: 0,
    parseCache: new Map(),
    previewModels: new Map(),
    enabledDocuments: new Set(),
    workspaceState: { get: () => undefined }
  };
  return { context, document, messages, get html() { return html; } };
}

test('supports exact matching across global and column filters', () => {
  const model = {
    columnCount: 2,
    dataRows: [
      { row: { cells: [{ value: 'Maple Street' }, { value: 'Toronto' }] } },
      { row: { cells: [{ value: 'Maple' }, { value: 'Toronto' }] } }
    ]
  };

  assert.equal(getFilteredTablePreviewRows(model, { globalTerm: 'Maple' }).length, 2);
  assert.equal(getFilteredTablePreviewRows(model, { globalTerm: 'Maple', exactMatch: true }).length, 1);
  assert.equal(getFilteredTablePreviewRows(model, {
    columnTerms: [{ index: 1, term: 'toronto' }],
    exactMatch: true
  }).length, 2);
  assert.equal(getFilteredTablePreviewRows(model, {
    columnTerms: [{ index: 0, term: 'Maple' }],
    exactMatch: true
  }).length, 1);
});

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

test('lints streamed CSV records and tracks physical lines across quoted newlines', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anyacsv-large-lint-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'records.csv');
  await fs.writeFile(filePath, 'name,value\r\nAlice,1\r\n"Bob\nB",2\r\nBad,3,extra\r\n');
  const uri = { fsPath: filePath, toString: () => `file://${filePath}` };
  const context = { workspaceState: { get: () => undefined }, enabledDocuments: new Set() };

  const model = await buildLargeCsvTablePreview(uri, context, 'csv');

  assert.equal(model.sourceTotalRowCount, 3);
  assert.equal(model.lintIssueCount, 1);
  assert.deepEqual(model.lintIssues[0], {
    severity: 'Warning',
    line: 5,
    column: 1,
    message: 'Expected 2 columns but found 3.'
  });
});

test('reports streamed CSV quote errors with line and column', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anyacsv-large-lint-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'invalid.csv');
  await fs.writeFile(filePath, 'A,B\nAb"c,1\n');
  const uri = { fsPath: filePath, toString: () => `file://${filePath}` };
  const context = { workspaceState: { get: () => undefined }, enabledDocuments: new Set() };

  const model = await buildLargeCsvTablePreview(uri, context, 'csv');

  assert.equal(model.lintIssueCount, 1);
  assert.deepEqual(model.lintIssues[0], {
    severity: 'Error',
    line: 2,
    column: 3,
    message: 'Quote character inside an unquoted field.'
  });
});

test('reuses the preview delimiter when early rows stop matching auto-detection', () => {
  const fixture = createPreviewFixture('name,value\nAlice,1\nBob,2\n');
  fixture.document.setText('edited header\nplain opening row\nthird,row,still delimited\n');

  assert.equal(refreshTablePreview(fixture.document, fixture.context), true, JSON.stringify(fixture.messages));
  assert.match(fixture.html, /delimiter: ,/);
  assert.equal(fixture.messages.length, 0);
});

test('re-detects automatically when the cached delimiter no longer matches', () => {
  const fixture = createPreviewFixture('name,value\nAlice,1\nBob,2\n');
  fixture.document.setText('name;value\nAda;1\n');

  assert.equal(refreshTablePreview(fixture.document, fixture.context), true);
  assert.match(fixture.html, /delimiter: ;/);
  assert.equal(fixture.messages.length, 0);
});

test('keeps the last preview on recognition failure and lets the user re-detect', () => {
  const fixture = createPreviewFixture('name,value\nAlice,1\nBob,2\n');
  assert.equal(refreshTablePreview(fixture.document, fixture.context), true);
  const lastGoodHtml = fixture.html;
  const lastGoodModel = fixture.context.previewModels.get(fixture.document.uri.toString());
  fixture.document.setText('');

  assert.equal(refreshTablePreview(fixture.document, fixture.context), false);
  assert.equal(fixture.html, lastGoodHtml);
  assert.equal(fixture.context.previewModels.get(fixture.document.uri.toString()), lastGoodModel);
  assert.match(fixture.messages[0].message, /edited or emptied/);
  assert.match(fixture.messages[0].message, /previous table is still shown/);

  fixture.document.setText('name;value\nAda;1\n');
  assert.equal(refreshTablePreview(fixture.document, fixture.context, { redetect: true }), true, JSON.stringify(fixture.messages));
  assert.match(fixture.html, /delimiter: ;/);
  assert.match(fixture.html, /redetect: true/);
});

test('creates color decorations only for cells in the visible editor ranges', () => {
  const text = 'a,b\nc,d\ne,f\n';
  const lineOffsets = [0, 4, 8];
  const document = {
    uri: { scheme: 'file', fsPath: '/tmp/visible.csv', toString: () => 'file:///tmp/visible.csv' },
    languageId: 'csv',
    version: 1,
    getText: () => text,
    offsetAt: position => lineOffsets[position.line] + position.character,
    positionAt: offset => {
      let line = lineOffsets.length - 1;
      while (line > 0 && lineOffsets[line] > offset) line -= 1;
      return { line, character: offset - lineOffsets[line] };
    }
  };
  const context = {
    workspaceState: { get: () => undefined },
    enabledDocuments: new Set(),
    parseCache: new Map(),
    decorations: Array.from({ length: 18 }, () => ({}))
  };
  const applied = new Map();
  const editor = {
    document,
    visibleRanges: [{ start: { line: 1, character: 0 }, end: { line: 2, character: 3 } }],
    setDecorations: (decoration, ranges) => applied.set(decoration, ranges)
  };

  updateDecorations(editor, context);

  assert.deepEqual(applied.get(context.decorations[0]).map(range => range.start.line), [1, 2]);
  assert.deepEqual(applied.get(context.decorations[1]).map(range => range.start.line), [1, 2]);
  assert.equal(applied.get(context.decorations[0]).some(range => range.start.line === 0), false);
});
