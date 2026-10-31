const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');

const FILE_EXTENSIONS = new Set(['.csv', '.tsv', '.psv', '.ssv', '.dsv', '.tab']);
const TEXT_EXTENSIONS = new Set(['.txt']);
const LANGUAGE_IDS = new Set(['csv', 'tsv', 'csv (semicolon)', 'csv (whitespace)', 'csv (pipe)', 'dynamic csv']);
const DELIMITER_CANDIDATES = [',', '\t', ';', '|', ':', '\x1f', 'whitespace'];
const COLOR_IDS = [
  'charts.red',
  'charts.blue',
  'charts.yellow',
  'charts.orange',
  'charts.green',
  'charts.purple',
  'terminal.ansiCyan',
  'terminal.ansiMagenta',
  'terminal.ansiGreen',
  'terminal.ansiRed',
  'terminal.ansiBlue',
  'terminal.ansiYellow',
  'terminal.ansiBrightCyan',
  'terminal.ansiBrightMagenta',
  'terminal.ansiBrightGreen',
  'terminal.ansiBrightRed',
  'terminal.ansiBrightBlue',
  'terminal.ansiBrightYellow'
];

function printableDelimiter(delimiter) {
  if (delimiter === '\t') return 'TAB';
  if (delimiter === '\x1f') return 'US';
  if (delimiter === 'whitespace') return 'whitespace';
  return delimiter;
}

function configuredDelimiter(document, context) {
  const override = context.workspaceState.get(`delimiter:${document.uri.toString()}`);
  if (typeof override === 'string') return override;
  const configured = vscode.workspace.getConfiguration('anycsv', document.uri).get('delimiter', 'auto');
  if (configured !== 'auto') return configured === '\\t' ? '\t' : configured;
  switch (document.languageId) {
    case 'tsv': return '\t';
    case 'csv (semicolon)': return ';';
    case 'csv (whitespace)': return 'whitespace';
    case 'csv (pipe)': return '|';
    default: return 'auto';
  }
}

function isCsvDocument(document, context) {
  if (context.enabledDocuments.has(document.uri.toString())) return true;
  if (LANGUAGE_IDS.has(document.languageId)) return true;
  if (document.uri.scheme === 'file' && FILE_EXTENSIONS.has(path.extname(document.uri.fsPath).toLowerCase())) return true;
  const config = vscode.workspace.getConfiguration('anycsv', document.uri);
  if (configuredDelimiter(document, context) !== 'auto') return true;
  const isTextCandidate = document.languageId === 'plaintext'
    || (document.uri.scheme === 'file' && TEXT_EXTENSIONS.has(path.extname(document.uri.fsPath).toLowerCase()));
  return isTextCandidate
    && config.get('autoDetect', true)
    && getParsed(document, context).autoDetected;
}

function parseDelimited(text, delimiter, quoteCharacter) {
  const rows = [];
  const errors = [];
  const row = [];
  let fieldStart = 0;
  let rowStart = 0;
  let value = '';
  let inQuotes = false;
  let afterQuote = false;
  let wasQuoted = false;
  let whitespacePending = false;
  const whitespaceMode = delimiter === 'whitespace';
  const quote = quoteCharacter && quoteCharacter.length === 1 ? quoteCharacter : '';

  function finishField(end) {
    row.push({ start: fieldStart, end, value, quoted: wasQuoted });
    fieldStart = end;
    value = '';
    wasQuoted = false;
    afterQuote = false;
  }

  function finishRow(end) {
    const rawRow = text.slice(rowStart, end);
    rows.push({ start: rowStart, end, cells: row.splice(0), blank: whitespaceMode ? rawRow.trim().length === 0 : rawRow.length === 0 });
  }

  for (let i = 0; i < text.length;) {
    const character = text[i];

    if (i === 0 && character === '\uFEFF') {
      i += 1;
      fieldStart = i;
      rowStart = i;
      continue;
    }

    if (inQuotes) {
      if (character === quote) {
        if (text[i + 1] === quote) {
          value += quote;
          i += 2;
        } else {
          inQuotes = false;
          afterQuote = true;
          i += 1;
        }
      } else {
        value += character;
        i += 1;
      }
      continue;
    }

    if (whitespaceMode && character !== '\r' && character !== '\n' && /\s/.test(character)) {
      let end = i + 1;
      while (end < text.length && text[end] !== '\r' && text[end] !== '\n' && /\s/.test(text[end])) end += 1;
      if (row.length === 0 && value.length === 0 && !wasQuoted && !afterQuote) {
        fieldStart = end;
      } else {
        finishField(i);
        fieldStart = end;
        whitespacePending = true;
      }
      i = end;
      continue;
    }

    if (!whitespaceMode && delimiter && text.startsWith(delimiter, i)) {
      finishField(i);
      i += delimiter.length;
      fieldStart = i;
      continue;
    }

    if (character === '\n' || character === '\r') {
      if (!(whitespaceMode && whitespacePending)) finishField(i);
      finishRow(i);
      i += character === '\r' && text[i + 1] === '\n' ? 2 : 1;
      fieldStart = i;
      rowStart = i;
      whitespacePending = false;
      continue;
    }

    whitespacePending = false;

    if (quote && character === quote) {
      if (!afterQuote && value.length === 0 && !wasQuoted) {
        inQuotes = true;
        wasQuoted = true;
      } else if (!afterQuote) {
        errors.push({ start: i, end: i + 1, message: 'Quote character inside an unquoted field.' });
        value += character;
      } else {
        errors.push({ start: i, end: i + 1, message: 'Unexpected quote after a closing quote.' });
        value += character;
        afterQuote = false;
      }
      i += 1;
      continue;
    }

    if (afterQuote) {
      if (character === ' ' || character === '\t') {
        i += 1;
        continue;
      }
      errors.push({ start: i, end: i + 1, message: 'Unexpected character after a closing quote.' });
      afterQuote = false;
    }
    value += character;
    i += 1;
  }

  if (inQuotes) {
    errors.push({ start: fieldStart, end: text.length, message: 'Unclosed quoted field.' });
  }
  if (fieldStart < text.length || row.length > 0 || (text.length > 0 && !/[\r\n]$/.test(text))) {
    if (!(whitespaceMode && whitespacePending)) finishField(text.length);
    finishRow(text.length);
  }
  return { rows, errors };
}

function detectionSample(text, quoteCharacter, maxRows, separators) {
  const maxChars = Math.min(text.length, 65536);
  const quote = quoteCharacter && quoteCharacter.length === 1 ? quoteCharacter : '';
  let inQuotes = false;
  let fieldStart = true;
  let rowCount = 0;
  for (let i = 0; i < maxChars;) {
    const character = text[i];
    if (i === 0 && character === '\uFEFF') {
      i += 1;
      continue;
    }
    if (quote && character === quote) {
      if (inQuotes && text[i + 1] === quote) {
        i += 2;
        continue;
      }
      if (inQuotes) inQuotes = false;
      else if (fieldStart) inQuotes = true;
      fieldStart = false;
      i += 1;
      continue;
    }
    if (!inQuotes && (character === '\r' || character === '\n')) {
      rowCount += 1;
      const next = i + (character === '\r' && text[i + 1] === '\n' ? 2 : 1);
      if (rowCount >= maxRows) return text.slice(0, next);
      fieldStart = true;
      i = next;
      continue;
    }
    if (!inQuotes) {
      const separator = separators.find(item => item !== 'whitespace' && text.startsWith(item, i));
      if (separator) {
        fieldStart = true;
        i += separator.length;
        continue;
      }
      if (character !== '\r' && character !== '\n' && /\s/.test(character)) fieldStart = true;
      else fieldStart = false;
    }
    i += 1;
  }
  return text.slice(0, maxChars);
}

function detectDelimiter(text, quoteCharacter, maxRows, singleRowMinimumColumns, additionalSeparators) {
  const separators = [...new Set([...DELIMITER_CANDIDATES, ...additionalSeparators])];
  const sample = detectionSample(text, quoteCharacter, maxRows, separators);
  let winner = ',';
  let bestScore = -1;
  for (const candidate of separators) {
    const parsed = parseDelimited(sample, candidate, quoteCharacter);
    const rows = parsed.rows.filter(item => !item.blank).slice(0, maxRows);
    const widths = rows.map(item => item.cells.length);
    const counts = new Map();
    for (const width of widths) counts.set(width, (counts.get(width) || 0) + 1);
    const mode = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    if (!mode || mode[0] < 2) continue;
    if (rows.length === 1) {
      if (candidate === 'whitespace' || mode[0] < singleRowMinimumColumns) continue;
    } else if (mode[1] < Math.max(2, Math.ceil(rows.length * 0.8))) {
      continue;
    }
    const customPriority = additionalSeparators.includes(candidate) ? 1000 : 0;
    const separatorLength = candidate === 'whitespace' ? 0 : candidate.length;
    const score = mode[1] * 10000 + customPriority + separatorLength - separators.indexOf(candidate);
    if (score > bestScore) {
      bestScore = score;
      winner = candidate;
    }
  }
  return bestScore < 0 ? undefined : winner;
}

function getParsed(document, context) {
  const config = vscode.workspace.getConfiguration('anycsv', document.uri);
  const quoteCharacter = config.get('quoteCharacter', '"');
  const requested = configuredDelimiter(document, context);
  const autoDetect = config.get('autoDetect', true);
  const sampleRows = config.get('autoDetectSampleRows', 20);
  const configuredSeparators = config.get('autoDetectSeparators', []);
  const additionalSeparators = Array.isArray(configuredSeparators)
    ? configuredSeparators
      .filter(item => typeof item === 'string' && item.length > 0 && !/[\r\n]/.test(item))
      .map(item => item === '\\t' ? '\t' : item)
    : [];
  const cached = context.parseCache.get(document.uri.toString());
  if (cached
    && cached.version === document.version
    && cached.quoteCharacter === quoteCharacter
    && cached.requested === requested
    && cached.autoDetect === autoDetect
    && cached.sampleRows === sampleRows
    && cached.additionalSeparatorsKey === JSON.stringify(additionalSeparators)) {
    return cached;
  }
  const autoDetectedDelimiter = requested === 'auto' && autoDetect
    ? detectDelimiter(
      document.getText(),
      quoteCharacter,
      sampleRows,
      document.languageId === 'plaintext' && !context.enabledDocuments.has(document.uri.toString()) ? 3 : 2,
      additionalSeparators
    )
    : undefined;
  const delimiter = requested && requested !== 'auto' ? requested : (autoDetectedDelimiter || ',');
  const parsed = parseDelimited(document.getText(), delimiter, quoteCharacter);
  const result = {
    version: document.version,
    delimiter,
    quoteCharacter,
    requested,
    autoDetect,
    sampleRows,
    additionalSeparatorsKey: JSON.stringify(additionalSeparators),
    autoDetected: Boolean(autoDetectedDelimiter),
    ...parsed
  };
  context.parseCache.set(document.uri.toString(), result);
  return result;
}

function lintDocument(document, parsed, context) {
  const config = vscode.workspace.getConfiguration('anycsv', document.uri);
  const headerRow = config.get('headerRow', 1);
  const ignoreEmptyLines = config.get('ignoreEmptyLines', true);
  const diagnostics = parsed.errors.map(error => {
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(document.positionAt(error.start), document.positionAt(error.end)),
      error.message,
      vscode.DiagnosticSeverity.Error
    );
    diagnostic.source = 'AnyCSV';
    diagnostic.code = 'csv-quoting';
    return diagnostic;
  });

  const dataRows = parsed.rows.filter(row => !(ignoreEmptyLines && row.blank));
  const header = headerRow > 0 ? parsed.rows[headerRow - 1] : undefined;
  const baseline = header && !(ignoreEmptyLines && header.blank)
    ? header.cells.length
    : dataRows[0]?.cells.length;
  if (baseline !== undefined) {
    for (const row of parsed.rows) {
      if (ignoreEmptyLines && row.blank) continue;
      if (header && row === header) continue;
      if (row.cells.length === baseline) continue;
      const position = document.positionAt(row.start);
      const rowEnd = document.positionAt(row.end);
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(position, rowEnd),
        `Expected ${baseline} columns but found ${row.cells.length}.`,
        vscode.DiagnosticSeverity.Warning
      );
      diagnostic.source = 'AnyCSV';
      diagnostic.code = 'csv-column-count';
      diagnostics.push(diagnostic);
    }
  }

  context.diagnostics.set(document.uri, diagnostics);
  return diagnostics;
}

function refreshDocument(document, context) {
  const isDelimited = isCsvDocument(document, context);
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor?.document.uri.toString() === document.uri.toString()) {
    vscode.commands.executeCommand('setContext', 'anycsv.isDelimited', isDelimited);
  }
  if (!isDelimited) {
    context.diagnostics.delete(document.uri);
    if (vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()) {
      updateStatus(context);
    }
    return;
  }
  const parsed = getParsed(document, context);
  lintDocument(document, parsed, context);
  if (vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()) {
    updateStatus(context);
  }
}

function getColumnName(document, parsed, rowIndex, columnIndex, context) {
  const headerRowNumber = vscode.workspace.getConfiguration('anycsv', document.uri).get('headerRow', 1);
  const header = headerRowNumber > 0 ? parsed.rows[headerRowNumber - 1] : undefined;
  const source = header?.cells[columnIndex];
  if (source && (rowIndex !== headerRowNumber - 1 || source.value.trim())) return source.value.trim();
  if (rowIndex === headerRowNumber - 1) return parsed.rows[rowIndex]?.cells[columnIndex]?.value.trim() || undefined;
  return undefined;
}

function findCell(document, parsed, position) {
  const offset = document.offsetAt(position);
  let low = 0;
  let high = parsed.rows.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const row = parsed.rows[middle];
    if (offset < row.start) high = middle - 1;
    else if (offset > row.end) low = middle + 1;
    else {
      const cell = row.cells.find(item => offset >= item.start && offset <= item.end);
      return cell ? { cell, row, rowIndex: middle, columnIndex: row.cells.indexOf(cell) } : undefined;
    }
  }
  return undefined;
}

function updateStatus(context) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isCsvDocument(editor.document, context)) {
    context.statusBar.hide();
    return;
  }
  const diagnostics = context.diagnostics.get(editor.document.uri) || [];
  const errors = diagnostics.filter(item => item.severity === vscode.DiagnosticSeverity.Error).length;
  const warnings = diagnostics.length - errors;
  const summary = diagnostics.length === 0
    ? '$(check) CSV: clean'
    : `$(warning) CSV: ${diagnostics.length} issue${diagnostics.length === 1 ? '' : 's'}`;
  context.statusBar.text = summary;
  context.statusBar.tooltip = `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'} · delimiter: ${printableDelimiter(getParsed(editor.document, context).delimiter)} · Click to show lint`;
  context.statusBar.command = 'anycsv.showLint';
  context.statusBar.show();
}

function updateDecorations(editor, context) {
  if (!editor || !isCsvDocument(editor.document, context)) {
    for (const decoration of context.decorations) editor?.setDecorations(decoration, []);
    return;
  }
  const parsed = getParsed(editor.document, context);
  const ranges = COLOR_IDS.map(() => []);
  let count = 0;
  for (const row of parsed.rows) {
    for (let column = 0; column < row.cells.length; column += 1) {
      const cell = row.cells[column];
      if (cell.end > cell.start && count < 50000) {
        ranges[column % ranges.length].push(new vscode.Range(
          editor.document.positionAt(cell.start),
          editor.document.positionAt(cell.end)
        ));
        count += 1;
      }
    }
  }
  context.decorations.forEach((decoration, index) => editor.setDecorations(decoration, ranges[index]));
}

async function showLint(context) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isCsvDocument(editor.document, context)) return;
  const diagnostics = context.diagnostics.get(editor.document.uri) || [];
  if (diagnostics.length === 0) {
    vscode.window.showInformationMessage('AnyCSV: no lint issues found.');
    return;
  }
  const choices = diagnostics.map(diagnostic => ({
    label: `Line ${diagnostic.range.start.line + 1}: ${diagnostic.message}`,
    description: diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning',
    diagnostic
  }));
  const selected = await vscode.window.showQuickPick(choices, { placeHolder: 'AnyCSV lint issues' });
  if (selected) {
    editor.selection = new vscode.Selection(selected.diagnostic.range.start, selected.diagnostic.range.end);
    editor.revealRange(selected.diagnostic.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

const PREVIEW_PAGE_SIZE = 100;
const PREVIEW_MAX_COLUMNS = 200;

function getTablePreviewModel(document, parsed) {
  const config = vscode.workspace.getConfiguration('anycsv', document.uri);
  const headerRowNumber = config.get('headerRow', 1);
  const ignoreEmptyLines = config.get('ignoreEmptyLines', true);
  const possibleHeaderIndex = Number.isInteger(headerRowNumber) && headerRowNumber > 0
    ? headerRowNumber - 1
    : -1;
  const possibleHeader = possibleHeaderIndex >= 0 ? parsed.rows[possibleHeaderIndex] : undefined;
  const hasHeader = Boolean(possibleHeader && !(ignoreEmptyLines && possibleHeader.blank));
  const headerIndex = hasHeader ? possibleHeaderIndex : -1;
  const dataRows = parsed.rows
    .map((row, index) => ({ row, index }))
    .filter(item => item.index !== headerIndex && !(ignoreEmptyLines && item.row.blank));

  let sourceColumnCount = hasHeader ? possibleHeader.cells.length : 0;
  for (const { row } of dataRows) sourceColumnCount = Math.max(sourceColumnCount, row.cells.length);
  const columnCount = Math.min(sourceColumnCount, PREVIEW_MAX_COLUMNS);
  const headers = Array.from({ length: columnCount }, (_, index) => {
    const name = hasHeader ? possibleHeader.cells[index]?.value.trim() : '';
    return name || `Column ${index + 1}`;
  });
  return { dataRows, sourceColumnCount, columnCount, headers };
}

function sendTablePreviewPage(uri, panel, context, request) {
  const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri);
  if (!document) return;
  const model = getTablePreviewModel(document, getParsed(document, context));
  const globalTerm = typeof request.globalTerm === 'string'
    ? request.globalTerm.trim().toLocaleLowerCase()
    : '';
  const columnTerms = Array.isArray(request.columnTerms)
    ? request.columnTerms
      .filter(item => item && Number.isInteger(item.index) && item.index >= 0 && item.index < model.columnCount && typeof item.term === 'string')
      .map(item => ({ index: item.index, term: item.term.trim().toLocaleLowerCase() }))
      .filter(item => item.term)
    : [];
  const filteredRows = model.dataRows.filter(({ row }) => {
    const matchesGlobal = !globalTerm || row.cells
      .slice(0, model.columnCount)
      .some(cell => cell.value.toLocaleLowerCase().includes(globalTerm));
    const matchesColumns = columnTerms.every(filter =>
      (row.cells[filter.index]?.value ?? '').toLocaleLowerCase().includes(filter.term)
    );
    return matchesGlobal && matchesColumns;
  });
  const pageCount = Math.ceil(filteredRows.length / PREVIEW_PAGE_SIZE);
  const requestedPage = Number.isInteger(request.page) ? request.page : 0;
  const page = pageCount === 0 ? 0 : Math.min(Math.max(0, requestedPage), pageCount - 1);
  const rows = filteredRows
    .slice(page * PREVIEW_PAGE_SIZE, (page + 1) * PREVIEW_PAGE_SIZE)
    .map(({ row }) => Array.from(
      { length: model.columnCount },
      (_, index) => row.cells[index]?.value ?? ''
    ));
  panel.webview.postMessage({
    type: 'pageData',
    requestId: request.requestId,
    rows,
    page,
    pageSize: PREVIEW_PAGE_SIZE,
    filteredRowCount: filteredRows.length,
    totalRowCount: model.dataRows.length
  });
}

function buildTablePreviewHtml(document, parsed) {
  const { dataRows, sourceColumnCount, columnCount, headers } = getTablePreviewModel(document, parsed);
  const tableHeader = headers.map((name, index) => `
      <th scope="col">
        <div class="column-name">${escapeHtml(name)}</div>
        <input class="column-filter" type="search" data-column="${index}" aria-label="Filter ${escapeHtml(name)}" placeholder="Filter column…">
      </th>`).join('');
  const description = `${dataRows.length.toLocaleString()} rows · ${PREVIEW_PAGE_SIZE} rows per page · delimiter: ${printableDelimiter(parsed.delimiter)}`;
  const columnNote = sourceColumnCount > PREVIEW_MAX_COLUMNS
    ? `<p class="description">Showing the first ${PREVIEW_MAX_COLUMNS} of ${sourceColumnCount.toLocaleString()} columns.</p>`
    : '';
  const nonce = crypto.randomBytes(16).toString('hex');
  const fileName = path.basename(document.uri.fsPath) || 'CSV Table';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>${escapeHtml(fileName)}</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 16px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); }
    .toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
    .toolbar h1 { margin: 0; font-size: 1.15em; font-weight: 600; }
    #global-filter, .column-filter { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; padding: 5px 7px; font: inherit; }
    #global-filter { width: min(360px, 100%); }
    #global-filter:focus, .column-filter:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    #result-count { margin-left: auto; opacity: .8; white-space: nowrap; }
    .description { margin: 0 0 12px; opacity: .8; }
    .pagination { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin: 0 0 10px; }
    .pagination button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 2px; padding: 5px 10px; font: inherit; cursor: pointer; }
    .pagination button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    .pagination button:disabled { opacity: .55; cursor: default; }
    #page-status { min-width: 90px; text-align: center; opacity: .85; }
    .table-scroll { max-width: 100%; max-height: calc(100vh - 112px); overflow: auto; border: 1px solid var(--vscode-panel-border, #888); }
    table { width: max-content; min-width: 100%; border-collapse: separate; border-spacing: 0; table-layout: fixed; }
    th, td { min-width: 160px; max-width: 360px; padding: 7px 9px; text-align: left; vertical-align: top; border-right: 1px solid var(--vscode-panel-border, #888); border-bottom: 1px solid var(--vscode-panel-border, #888); overflow-wrap: anywhere; }
    th { position: sticky; top: 0; z-index: 1; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
    th:last-child, td:last-child { border-right: 0; }
    .column-name { margin-bottom: 5px; font-weight: 600; white-space: normal; }
    .column-filter { width: 100%; min-width: 0; }
    td { white-space: pre-wrap; }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    .empty { padding: 18px; opacity: .8; }
  </style>
</head>
<body>
  <div class="toolbar">
    <h1>${escapeHtml(fileName)}</h1>
    <input id="global-filter" type="search" aria-label="Filter all columns" placeholder="Filter all columns…">
    <span id="result-count" aria-live="polite"></span>
  </div>
  <p class="description">${escapeHtml(description)}</p>
  ${columnNote}
  ${columnCount === 0 ? '<p class="empty">No delimited data to preview.</p>' : `
  <div class="pagination" aria-label="Table pagination">
    <button id="previous-page" type="button">Previous</button>
    <span id="page-status" aria-live="polite">Loading…</span>
    <button id="next-page" type="button">Next</button>
  </div>
  <div class="table-scroll">
    <table>
      <thead><tr>${tableHeader}</tr></thead>
      <tbody id="preview-rows"><tr><td colspan="${columnCount}">Loading…</td></tr></tbody>
    </table>
  </div>`}
  <script nonce="${nonce}">
    (() => {
      const globalFilter = document.getElementById('global-filter');
      const columnFilters = [...document.querySelectorAll('.column-filter')];
      const count = document.getElementById('result-count');
      if (${columnCount > 0}) {
        const api = acquireVsCodeApi();
        const body = document.getElementById('preview-rows');
        const previous = document.getElementById('previous-page');
        const next = document.getElementById('next-page');
        const pageStatus = document.getElementById('page-status');
        let currentPage = 0;
        let requestId = 0;
        function requestPage(page) {
          currentPage = page;
          requestId += 1;
          const columnTerms = columnFilters
            .map(input => ({ index: Number(input.dataset.column), term: input.value }))
            .filter(filter => filter.term.trim());
          api.postMessage({
            type: 'query',
            requestId,
            page: currentPage,
            globalTerm: globalFilter.value,
            columnTerms
          });
        }
        window.addEventListener('message', event => {
          const message = event.data;
          if (!message || message.type !== 'pageData' || message.requestId !== requestId) return;
          currentPage = message.page;
          const fragment = document.createDocumentFragment();
          for (const values of message.rows) {
            const row = document.createElement('tr');
            for (const value of values) {
              const cell = document.createElement('td');
              cell.textContent = value;
              row.appendChild(cell);
            }
            fragment.appendChild(row);
          }
          if (message.rows.length === 0) {
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = ${columnCount};
            cell.textContent = 'No rows match these filters.';
            row.appendChild(cell);
            fragment.appendChild(row);
          }
          body.replaceChildren(fragment);
          count.textContent = message.filteredRowCount.toLocaleString() + ' matching / ' + message.totalRowCount.toLocaleString() + ' rows';
          const pageCount = Math.ceil(message.filteredRowCount / message.pageSize);
          pageStatus.textContent = pageCount ? 'Page ' + (currentPage + 1).toLocaleString() + ' of ' + pageCount.toLocaleString() : 'Page 0 of 0';
          previous.disabled = currentPage <= 0;
          next.disabled = currentPage + 1 >= pageCount;
        });
        previous.addEventListener('click', () => requestPage(currentPage - 1));
        next.addEventListener('click', () => requestPage(currentPage + 1));
        globalFilter.addEventListener('input', () => requestPage(0));
        columnFilters.forEach(input => input.addEventListener('input', () => requestPage(0)));
        requestPage(0);
      }
    })();
  </script>
</body>
</html>`;
}

function refreshTablePreview(document, context) {
  const panel = context.previewPanels.get(document.uri.toString());
  if (!panel || !isCsvDocument(document, context)) return;
  panel.webview.html = buildTablePreviewHtml(document, getParsed(document, context));
}

function showTablePreview(context) {
  const document = vscode.window.activeTextEditor?.document;
  if (!document) return;
  if (!isCsvDocument(document, context)) {
    vscode.window.showWarningMessage('AnyCSV could not identify this file as delimited data. Use “AnyCSV: Enable for Current File” first.');
    return;
  }

  const uri = document.uri.toString();
  let panel = context.previewPanels.get(uri);
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'anycsv.tablePreview',
      'AnyCSV Table Preview',
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [] }
    );
    context.previewPanels.set(uri, panel);
    const messageListener = panel.webview.onDidReceiveMessage(message => {
      if (message?.type === 'query') sendTablePreviewPage(uri, panel, context, message);
    });
    context.hostSubscriptions.push(messageListener);
    context.hostSubscriptions.push(panel.onDidDispose(() => {
      messageListener.dispose();
      context.previewPanels.delete(uri);
    }));
  }
  panel.title = `AnyCSV: ${path.basename(document.uri.fsPath) || 'CSV Table'}`;
  panel.webview.html = buildTablePreviewHtml(document, getParsed(document, context));
  panel.reveal(vscode.ViewColumn.Active);
}

async function applyDocumentDelimiter(document, delimiter, extensionContext, hostContext) {
  const normalized = delimiter === '\\t' ? '\t' : delimiter;
  if (!normalized) {
    vscode.window.showErrorMessage('AnyCSV delimiter cannot be empty.');
    return false;
  }
  if (/[\r\n]/.test(normalized)) {
    vscode.window.showErrorMessage('AnyCSV separators cannot contain line breaks.');
    return false;
  }
  const uri = document.uri.toString();
  extensionContext.enabledDocuments.add(uri);
  await hostContext.globalState.update('enabledDocuments', [...extensionContext.enabledDocuments]);
  await extensionContext.workspaceState.update(`delimiter:${uri}`, normalized);
  extensionContext.parseCache.delete(uri);
  refreshDocument(document, extensionContext);
  refreshTablePreview(document, extensionContext);
  updateDecorations(vscode.window.activeTextEditor, extensionContext);
  updateStatus(extensionContext);
  return true;
}

async function promptForDynamicDelimiter(document, extensionContext, hostContext) {
  if (document.languageId !== 'dynamic csv') return;
  if (vscode.window.activeTextEditor?.document.uri.toString() !== document.uri.toString()) return;
  const current = configuredDelimiter(document, extensionContext);
  if (current !== 'auto') return;
  const input = await vscode.window.showInputBox({
    prompt: 'Enter a field separator for this Dynamic CSV file. Use \\t for tab.',
    value: current === 'auto' ? '' : current.replace(/\t/g, '\\t'),
    placeHolder: 'Any character or string'
  });
  if (input === undefined || input === '') return;
  await applyDocumentDelimiter(document, input, extensionContext, hostContext);
}

function observeLanguage(document, extensionContext, hostContext) {
  const uri = document.uri.toString();
  const previous = extensionContext.lastLanguageByUri.get(uri);
  extensionContext.lastLanguageByUri.set(uri, document.languageId);
  if (previous && previous !== 'dynamic csv' && document.languageId === 'dynamic csv') {
    setTimeout(() => promptForDynamicDelimiter(document, extensionContext, hostContext), 0);
  }
}

function activate(context) {
  const diagnostics = vscode.languages.createDiagnosticCollection('anycsv');
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  const decorations = COLOR_IDS.map(color => vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor(color),
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  }));
  const extensionContext = {
    diagnostics,
    statusBar,
    decorations,
    hostSubscriptions: context.subscriptions,
    enabledDocuments: new Set(context.globalState.get('enabledDocuments', [])),
    parseCache: new Map(),
    timers: new Map(),
    previewPanels: new Map(),
    lastLanguageByUri: new Map(),
    workspaceState: context.workspaceState
  };
  statusBar.command = 'anycsv.showLint';
  context.subscriptions.push(diagnostics, statusBar, ...decorations);

  context.subscriptions.push(vscode.languages.registerHoverProvider({ scheme: '*' }, {
    provideHover(document, position) {
      if (!isCsvDocument(document, extensionContext)) return undefined;
      const parsed = getParsed(document, extensionContext);
      const found = findCell(document, parsed, position);
      if (!found) return undefined;
      const name = getColumnName(document, parsed, found.rowIndex, found.columnIndex, extensionContext);
      const headerRow = vscode.workspace.getConfiguration('anycsv', document.uri).get('headerRow', 1);
      const rowLabel = found.rowIndex === headerRow - 1 ? 'Header' : `Row ${found.rowIndex + 1}`;
      const markdown = new vscode.MarkdownString();
      markdown.appendMarkdown(`**Column ${found.columnIndex + 1}**`);
      if (name) {
        markdown.appendMarkdown(' · ');
        markdown.appendText(name);
      }
      markdown.appendMarkdown(`  \n${rowLabel} · delimiter: `);
      markdown.appendText(printableDelimiter(parsed.delimiter));
      return new vscode.Hover(markdown, new vscode.Range(
        document.positionAt(found.cell.start),
        document.positionAt(found.cell.end)
      ));
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('anycsv.enableForCurrentFile', async () => {
    const document = vscode.window.activeTextEditor?.document;
    if (!document) return;
    extensionContext.enabledDocuments.add(document.uri.toString());
    await context.globalState.update('enabledDocuments', [...extensionContext.enabledDocuments]);
    refreshDocument(document, extensionContext);
    updateDecorations(vscode.window.activeTextEditor, extensionContext);
    vscode.window.showInformationMessage(`AnyCSV enabled for ${path.basename(document.uri.fsPath) || document.uri.toString()}.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('anycsv.setDelimiter', async () => {
    const document = vscode.window.activeTextEditor?.document;
    if (!document) return;
    const current = configuredDelimiter(document, extensionContext);
    const input = await vscode.window.showInputBox({
      prompt: 'Enter a field separator. Use \\t for tab.',
      value: current === 'auto' ? '' : current.replace(/\t/g, '\\t'),
      placeHolder: 'Comma, semicolon, pipe, tab, or a custom separator'
    });
    if (input === undefined) return;
    await applyDocumentDelimiter(document, input, extensionContext, context);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('anycsv.setDelimiterFromSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const delimiter = editor.document.getText(editor.selection);
    if (!delimiter) {
      vscode.window.showErrorMessage('Select the separator text first, then run this command.');
      return;
    }
    await applyDocumentDelimiter(editor.document, delimiter, extensionContext, context);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('anycsv.autoDetectDelimiter', async () => {
    const document = vscode.window.activeTextEditor?.document;
    if (!document) return;
    extensionContext.enabledDocuments.add(document.uri.toString());
    await context.globalState.update('enabledDocuments', [...extensionContext.enabledDocuments]);
    await extensionContext.workspaceState.update(`delimiter:${document.uri.toString()}`, 'auto');
    extensionContext.parseCache.delete(document.uri.toString());
    refreshDocument(document, extensionContext);
    refreshTablePreview(document, extensionContext);
    updateDecorations(vscode.window.activeTextEditor, extensionContext);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('anycsv.showLint', () => showLint(extensionContext)));
  context.subscriptions.push(vscode.commands.registerCommand('anycsv.previewTable', () => showTablePreview(extensionContext)));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
    observeLanguage(document, extensionContext, context);
    refreshDocument(document, extensionContext);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    const uri = event.document.uri.toString();
    const oldTimer = extensionContext.timers.get(uri);
    if (oldTimer) clearTimeout(oldTimer);
    extensionContext.timers.set(uri, setTimeout(() => {
      extensionContext.parseCache.delete(uri);
      refreshDocument(event.document, extensionContext);
      refreshTablePreview(event.document, extensionContext);
      updateDecorations(vscode.window.activeTextEditor, extensionContext);
    }, 150));
  }));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
    const uri = document.uri.toString();
    clearTimeout(extensionContext.timers.get(uri));
    extensionContext.timers.delete(uri);
    extensionContext.parseCache.delete(uri);
    diagnostics.delete(document.uri);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('anycsv')) {
      extensionContext.parseCache.clear();
      vscode.workspace.textDocuments.forEach(document => {
        refreshDocument(document, extensionContext);
        refreshTablePreview(document, extensionContext);
      });
      updateDecorations(vscode.window.activeTextEditor, extensionContext);
      updateStatus(extensionContext);
    }
  }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor) {
      observeLanguage(editor.document, extensionContext, context);
      refreshDocument(editor.document, extensionContext);
    } else {
      vscode.commands.executeCommand('setContext', 'anycsv.isDelimited', false);
    }
    updateDecorations(editor, extensionContext);
    updateStatus(extensionContext);
  }));

  vscode.workspace.textDocuments.forEach(document => {
    observeLanguage(document, extensionContext, context);
    refreshDocument(document, extensionContext);
  });
  updateDecorations(vscode.window.activeTextEditor, extensionContext);
  updateStatus(extensionContext);
}

function deactivate() {}

module.exports = { activate, deactivate };
