const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createDeflateRaw } = require('node:zlib');

const FILE_EXTENSIONS = new Set(['.csv', '.tsv', '.psv', '.ssv', '.dsv', '.tab']);
const LANGUAGE_IDS = new Set(['csv', 'tsv', 'csv (semicolon)', 'csv (whitespace)', 'csv (pipe)', 'dynamic csv']);
const GRAMMAR_LANGUAGE_IDS = new Set(['csv', 'tsv', 'csv (semicolon)', 'csv (whitespace)', 'csv (pipe)']);
const COLUMN_TOKEN_TYPES = Array.from({ length: 10 }, (_, index) => `anyacsvColumn${index + 1}`);
const DYNAMIC_CSV_HIGHLIGHT_MARGIN = 50;
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
  const configured = vscode.workspace.getConfiguration('anyacsv', document.uri).get('delimiter', 'auto');
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
  if (document.uri.scheme === 'file' && path.extname(document.uri.fsPath).toLowerCase() === '.txt') return false;
  const config = vscode.workspace.getConfiguration('anyacsv', document.uri);
  if (configuredDelimiter(document, context) !== 'auto') return true;
  return document.languageId === 'plaintext'
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

const LARGE_FILE_PREVIEW_THRESHOLD = 50_000_000;
const LARGE_FILE_PREVIEW_MAX_ROWS = 10000;
const LARGE_FILE_PREVIEW_MAX_CHARS = 10_000_000;

function countCsvLineBreaks(text) {
  return (text.match(/\r\n|\r|\n/g) || []).length;
}

function csvRecordLocation(record, offset) {
  const prefix = record.text.slice(0, offset);
  const lastLineBreak = Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf('\r'));
  return {
    line: record.line + countCsvLineBreaks(prefix),
    column: prefix.length - lastLineBreak
  };
}

async function* streamCsvRecords(filePath, delimiter, quoteCharacter, totalBytes, onProgress) {
  const input = fs.createReadStream(filePath);
  const decoder = new StringDecoder('utf8');
  const quote = quoteCharacter && quoteCharacter.length === 1 ? quoteCharacter : '';
  const whitespaceMode = delimiter === 'whitespace';
  let buffer = '';
  let rowParts = [];
  let inQuotes = false;
  let fieldStart = true;
  let atFileStart = true;
  let bytesRead = 0;
  let rowStartLine = 1;

  const consumeAvailable = (text, isFinalChunk) => {
    const records = [];
    let index = 0;
    let segmentStart = 0;
    while (index < text.length) {
      const character = text[index];
      if (atFileStart) {
        atFileStart = false;
        if (character === '\uFEFF') {
          index += 1;
          continue;
        }
      }
      if (inQuotes) {
        if (character === quote) {
          if (index + 1 >= text.length && !isFinalChunk) break;
          if (text[index + 1] === quote) {
            index += 2;
          } else {
            inQuotes = false;
            fieldStart = false;
            index += 1;
          }
        } else {
          index += 1;
        }
        continue;
      }

      if (!whitespaceMode && delimiter) {
        const remaining = text.length - index;
        if (remaining < delimiter.length && !isFinalChunk && delimiter.startsWith(text.slice(index))) break;
        if (text.startsWith(delimiter, index)) {
          fieldStart = true;
          index += delimiter.length;
          continue;
        }
      }
      if (whitespaceMode && character !== '\r' && character !== '\n' && /\s/.test(character)) {
        fieldStart = true;
        index += 1;
        continue;
      }
      if (quote && character === quote && fieldStart) {
        inQuotes = true;
        fieldStart = false;
        index += 1;
        continue;
      }
      if (character === '\r' || character === '\n') {
        if (character === '\r' && index + 1 >= text.length && !isFinalChunk) break;
        rowParts.push(text.slice(segmentStart, index));
        const recordText = rowParts.join('');
        records.push({ text: recordText, line: rowStartLine });
        rowStartLine += countCsvLineBreaks(recordText) + 1;
        rowParts = [];
        index += character === '\r' && text[index + 1] === '\n' ? 2 : 1;
        segmentStart = index;
        fieldStart = true;
        continue;
      }
      fieldStart = false;
      index += 1;
    }
    rowParts.push(text.slice(segmentStart, index));
    return { records, remainder: text.slice(index) };
  };

  for await (const chunk of input) {
    const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    bytesRead += bytes;
    if (onProgress) onProgress(bytesRead, totalBytes);
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    const consumed = consumeAvailable(buffer, false);
    for (const record of consumed.records) yield record;
    buffer = consumed.remainder;
  }

  buffer += decoder.end();
  const consumed = consumeAvailable(buffer, true);
  for (const record of consumed.records) yield record;
  buffer = consumed.remainder;
  const finalRecord = rowParts.join('') + buffer;
  if (finalRecord.length > 0) yield { text: finalRecord, line: rowStartLine };
}

async function readLargeCsvSample(filePath, maxBytes = 65536) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function largeCsvLanguageId(extension) {
  if (extension === '.tsv' || extension === '.tab') return 'tsv';
  if (extension === '.ssv') return 'csv (semicolon)';
  if (extension === '.psv') return 'csv (pipe)';
  return 'csv';
}

async function buildLargeCsvTablePreview(uri, context, languageId, onProgress, options = {}) {
  const filePath = uri.fsPath;
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.txt'
    && !LANGUAGE_IDS.has(languageId)
    && !context.enabledDocuments.has(uri.toString())) {
    throw new Error('Select an AnyaCSV language mode or enable AnyaCSV for this .txt file first.');
  }
  const stat = await fs.promises.stat(filePath);
  const document = { uri, languageId };
  const config = vscode.workspace.getConfiguration('anyacsv', uri);
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
  const sample = await readLargeCsvSample(filePath);
  const autoDetectedDelimiter = !options.delimiter && requested === 'auto' && autoDetect
    ? detectDelimiter(
      sample,
      quoteCharacter,
      sampleRows,
      languageId === 'plaintext' && !context.enabledDocuments.has(uri.toString()) ? 3 : 2,
      additionalSeparators
    )
    : undefined;
  if (languageId === 'plaintext'
    && !context.enabledDocuments.has(uri.toString())
    && requested === 'auto'
    && !autoDetectedDelimiter
    && !options.delimiter) {
    throw new Error('AnyaCSV could not identify this file as delimited data. Set a delimiter or enable AnyaCSV for this file.');
  }
  const delimiter = options.delimiter || (requested && requested !== 'auto' ? requested : autoDetectedDelimiter || ',');
  const headerRowSetting = config.get('headerRow', 1);
  const headerIndex = Number.isInteger(headerRowSetting) && headerRowSetting > 0 ? headerRowSetting - 1 : -1;
  const ignoreEmptyLines = config.get('ignoreEmptyLines', true);
  const rows = [];
  let header;
  let hasHeader = false;
  let sourceColumnCount = 0;
  let totalDataRowCount = 0;
  let previewCharacterCount = 0;
  let previewLimitReached = false;
  let lintIssueCount = 0;
  let hasMultipleColumns = false;
  const lintIssues = [];
  const pendingWidths = [];
  let baseline;
  let rowIndex = 0;
  const addLintIssue = (severity, line, column, message) => {
    lintIssueCount += 1;
    if (lintIssues.length < 10) lintIssues.push({ severity, line, column, message });
  };
  const checkWidth = (width, line) => {
    if (baseline !== undefined && width !== baseline) {
      addLintIssue('Warning', line, 1, `Expected ${baseline} columns but found ${width}.`);
    }
  };
  const finalizePendingWidths = () => {
    if (baseline === undefined) baseline = pendingWidths[0]?.width;
    for (let index = 1; index < pendingWidths.length; index += 1) {
      checkWidth(pendingWidths[index].width, pendingWidths[index].line);
    }
    pendingWidths.length = 0;
  };

  for await (const record of streamCsvRecords(filePath, delimiter, quoteCharacter, stat.size, onProgress)) {
    const parsed = record.text.length === 0
      ? { rows: [{ start: 0, end: 0, cells: [{ start: 0, end: 0, value: '', quoted: false }], blank: true }], errors: [] }
      : parseDelimited(record.text, delimiter, quoteCharacter);
    for (const error of parsed.errors) {
      const location = csvRecordLocation(record, error.start);
      addLintIssue('Error', location.line, location.column, error.message);
    }
    const row = parsed.rows[0];
    if (!row) {
      rowIndex += 1;
      continue;
    }
    if (row.cells.length > 1) hasMultipleColumns = true;
    const isEligible = !(ignoreEmptyLines && row.blank);
    if (rowIndex === headerIndex && isEligible) {
      header = row;
      hasHeader = true;
      sourceColumnCount = Math.max(sourceColumnCount, row.cells.length);
      baseline = row.cells.length;
      for (const pending of pendingWidths) checkWidth(pending.width, pending.line);
      pendingWidths.length = 0;
    } else if (rowIndex === headerIndex && !isEligible) {
      finalizePendingWidths();
    } else if (isEligible) {
      sourceColumnCount = Math.max(sourceColumnCount, row.cells.length);
      totalDataRowCount += 1;
      if (headerIndex >= 0 && !hasHeader && rowIndex < headerIndex) {
        pendingWidths.push({ width: row.cells.length, line: record.line });
      } else {
        if (baseline === undefined) baseline = row.cells.length;
        else checkWidth(row.cells.length, record.line);
      }
      if (!previewLimitReached && rows.length < LARGE_FILE_PREVIEW_MAX_ROWS) {
        const rowCharacters = row.cells.reduce((total, cell) => total + cell.value.length, 0);
        if (previewCharacterCount + rowCharacters <= LARGE_FILE_PREVIEW_MAX_CHARS) {
          rows.push({ row, index: rowIndex });
          previewCharacterCount += rowCharacters;
        } else {
          previewLimitReached = true;
        }
      }
    }
    rowIndex += 1;
  }

  if (!hasHeader) finalizePendingWidths();

  if (header) sourceColumnCount = Math.max(sourceColumnCount, header.cells.length);
  const columnCount = Math.min(sourceColumnCount, PREVIEW_MAX_COLUMNS);
  const headers = Array.from({ length: columnCount }, (_, index) => {
    const name = hasHeader ? header.cells[index]?.value.trim() : '';
    return name || `Column ${index + 1}`;
  });
  return {
    dataRows: rows,
    sourceColumnCount,
    columnCount,
    headers,
    delimiter,
    quoteCharacter,
    sourceTotalRowCount: totalDataRowCount,
    isPartial: totalDataRowCount > rows.length,
    isLargeFile: true,
    autoDetected: options.autoDetected ?? Boolean(autoDetectedDelimiter),
    hasMultipleColumns,
    lintIssueCount,
    lintIssues
  };
}

function getParsed(document, context, options = {}) {
  const config = vscode.workspace.getConfiguration('anyacsv', document.uri);
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
    && cached.delimiterOverride === options.delimiter
    && cached.quoteCharacter === quoteCharacter
    && cached.requested === requested
    && cached.autoDetect === autoDetect
    && cached.sampleRows === sampleRows
    && cached.additionalSeparatorsKey === JSON.stringify(additionalSeparators)) {
    return cached;
  }
  const autoDetectedDelimiter = !options.delimiter && requested === 'auto' && autoDetect
    ? detectDelimiter(
      document.getText(),
      quoteCharacter,
      sampleRows,
      document.languageId === 'plaintext' && !context.enabledDocuments.has(document.uri.toString()) ? 3 : 2,
      additionalSeparators
    )
    : undefined;
  const delimiter = options.delimiter || (requested && requested !== 'auto' ? requested : (autoDetectedDelimiter || ','));
  const parsed = parseDelimited(document.getText(), delimiter, quoteCharacter);
  const result = {
    version: document.version,
    delimiter,
    delimiterOverride: options.delimiter,
    quoteCharacter,
    requested,
    autoDetect,
    sampleRows,
    additionalSeparatorsKey: JSON.stringify(additionalSeparators),
    autoDetected: options.delimiter ? Boolean(options.autoDetected) : Boolean(autoDetectedDelimiter),
    ...parsed
  };
  context.parseCache.set(document.uri.toString(), result);
  return result;
}

function getSemanticTokenParseSettings(document, context) {
  const config = vscode.workspace.getConfiguration('anyacsv', document.uri);
  const quoteCharacter = config.get('quoteCharacter', '"');
  const requested = configuredDelimiter(document, context);
  if (requested && requested !== 'auto') return { delimiter: requested, quoteCharacter };

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
    && cached.requested === requested
    && cached.quoteCharacter === quoteCharacter
    && cached.autoDetect === autoDetect
    && cached.sampleRows === sampleRows
    && cached.additionalSeparatorsKey === JSON.stringify(additionalSeparators)) {
    return { delimiter: cached.delimiter, quoteCharacter };
  }

  const detectionSample = autoDetect
    ? document.getText(new vscode.Range(
      new vscode.Position(0, 0),
      document.positionAt(65536)
    ))
    : '';
  const autoDetectedDelimiter = autoDetect
    ? detectDelimiter(detectionSample, quoteCharacter, sampleRows, 2, additionalSeparators)
    : undefined;
  return { delimiter: autoDetectedDelimiter || ',', quoteCharacter };
}

function provideDynamicCsvSemanticTokens(document, range, context, legend) {
  if (document.languageId !== 'dynamic csv') return null;

  const { delimiter, quoteCharacter } = getSemanticTokenParseSettings(document, context);
  const startLine = Math.max(0, range.start.line - DYNAMIC_CSV_HIGHLIGHT_MARGIN);
  const endLine = Math.min(document.lineCount - 1, range.end.line + DYNAMIC_CSV_HIGHLIGHT_MARGIN);
  if (endLine < startLine) return new vscode.SemanticTokensBuilder(legend).build();

  const lastLine = document.lineAt(endLine);
  const text = document.getText(new vscode.Range(
    new vscode.Position(startLine, 0),
    new vscode.Position(endLine, lastLine.text.length)
  ));
  const parsed = parseDelimited(text, delimiter, quoteCharacter);
  const lineOffsets = [];
  let offset = 0;
  for (let line = startLine; line <= endLine; line += 1) {
    const lineText = document.lineAt(line).text;
    lineOffsets.push({ start: offset, end: offset + lineText.length });
    offset += lineText.length;
    if (line < endLine) {
      const nextStart = document.offsetAt(new vscode.Position(line + 1, 0));
      const currentStart = document.offsetAt(new vscode.Position(line, 0));
      offset += nextStart - currentStart - lineText.length;
    }
  }

  const builder = new vscode.SemanticTokensBuilder(legend);
  for (const row of parsed.rows) {
    for (let column = 1; column < row.cells.length; column += 1) {
      const cell = row.cells[column];
      const firstCellLine = Math.max(0, findLineOffsetIndex(lineOffsets, cell.start));
      const lastCellLine = Math.max(firstCellLine, findLineOffsetIndex(lineOffsets, Math.max(cell.start, cell.end - 1)));
      for (let lineIndex = firstCellLine; lineIndex <= lastCellLine && lineIndex < lineOffsets.length; lineIndex += 1) {
        const lineOffset = lineOffsets[lineIndex];
        const tokenStart = Math.max(cell.start, lineOffset.start);
        const tokenEnd = Math.min(cell.end, lineOffset.end);
        if (tokenEnd <= tokenStart) continue;
        const startCharacter = tokenStart - lineOffset.start;
        const endCharacter = tokenEnd - lineOffset.start;
        builder.push(
          new vscode.Range(startLine + lineIndex, startCharacter, startLine + lineIndex, endCharacter),
          COLUMN_TOKEN_TYPES[column % COLUMN_TOKEN_TYPES.length]
        );
      }
    }
  }
  return builder.build();
}

function findLineOffsetIndex(lineOffsets, offset) {
  let low = 0;
  let high = lineOffsets.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (lineOffsets[middle].end <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, lineOffsets.length - 1);
}

function lintDocument(document, parsed, context) {
  const config = vscode.workspace.getConfiguration('anyacsv', document.uri);
  const headerRow = config.get('headerRow', 1);
  const ignoreEmptyLines = config.get('ignoreEmptyLines', true);
  const diagnostics = parsed.errors.map(error => {
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(document.positionAt(error.start), document.positionAt(error.end)),
      error.message,
      vscode.DiagnosticSeverity.Error
    );
    diagnostic.source = 'AnyaCSV';
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
      diagnostic.source = 'AnyaCSV';
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
    vscode.commands.executeCommand('setContext', 'anyacsv.isDelimited', isDelimited);
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
  const headerRowNumber = vscode.workspace.getConfiguration('anyacsv', document.uri).get('headerRow', 1);
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
    else if (offset >= row.end) low = middle + 1;
    else {
      const columnIndex = row.cells.findIndex(item => offset >= item.start && offset < item.end);
      const cell = row.cells[columnIndex];
      return cell ? { cell, row, rowIndex: middle, columnIndex } : undefined;
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
  const isValid = diagnostics.length === 0;
  const topIssue = diagnostics.find(item => item.severity === vscode.DiagnosticSeverity.Error) || diagnostics[0];
  const diagnosticDetails = diagnostics.slice(0, 5).map(diagnostic =>
    `Line ${diagnostic.range.start.line + 1}: ${diagnostic.message}`
  );
  if (diagnostics.length > diagnosticDetails.length) {
    diagnosticDetails.push(`And ${diagnostics.length - diagnosticDetails.length} more; click to view all.`);
  }
  context.statusBar.text = topIssue
    ? `$(circle-filled) CSV: ${formatStatusBarIssue(`Line ${topIssue.range.start.line + 1}: ${topIssue.message}`)}`
    : '$(circle-filled) CSV';
  context.statusBar.color = isValid
    ? new vscode.ThemeColor('testing.iconPassed')
    : new vscode.ThemeColor('testing.iconFailed');
  context.statusBar.tooltip = isValid
    ? 'No CSV lint issues. Click to refresh lint.'
    : `${diagnosticDetails.join('\n')}\n${errors} error${errors === 1 ? '' : 's'} and ${warnings} warning${warnings === 1 ? '' : 's'}. Click to refresh lint.`;
  context.statusBar.command = 'anyacsv.showLint';
  context.statusBar.show();
}

function formatStatusBarIssue(message) {
  const normalized = message.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 79)}…` : normalized;
}

function clearEditorDecorations(editor, context) {
  context.clearedDecorationEditors ||= new WeakSet();
  if (context.clearedDecorationEditors.has(editor)) return;
  for (const decoration of context.decorations) editor.setDecorations(decoration, []);
  context.clearedDecorationEditors.add(editor);
}

function updateDecorations(editor, context) {
  if (!editor || !isCsvDocument(editor.document, context)) {
    if (editor) {
      clearEditorDecorations(editor, context);
      context.decorationStartTimes?.delete(editor.document.uri.toString());
    }
    return;
  }
  const document = editor.document;
  if (GRAMMAR_LANGUAGE_IDS.has(document.languageId) || document.languageId === 'dynamic csv') {
    clearEditorDecorations(editor, context);
    context.decorationStartTimes?.delete(document.uri.toString());
    return;
  }
  const parsed = getParsed(document, context);
  const visibleRanges = editor.visibleRanges
    .map(range => ({ start: document.offsetAt(range.start), end: document.offsetAt(range.end) }))
    .filter(range => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  const mergedVisibleRanges = [];
  for (const range of visibleRanges) {
    const previous = mergedVisibleRanges[mergedVisibleRanges.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else mergedVisibleRanges.push({ ...range });
  }
  const ranges = COLOR_IDS.map(() => []);
  let count = 0;
  for (const visibleRange of mergedVisibleRanges) {
    let low = 0;
    let high = parsed.rows.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (parsed.rows[middle].end <= visibleRange.start) low = middle + 1;
      else high = middle;
    }
    for (let rowIndex = low; rowIndex < parsed.rows.length && parsed.rows[rowIndex].start < visibleRange.end; rowIndex += 1) {
      const row = parsed.rows[rowIndex];
      for (let column = 0; column < row.cells.length && count < 50000; column += 1) {
        const cell = row.cells[column];
        const start = Math.max(cell.start, visibleRange.start);
        const end = Math.min(cell.end, visibleRange.end);
        if (end > start) {
          ranges[column % ranges.length].push(new vscode.Range(
            document.positionAt(start),
            document.positionAt(end)
          ));
          count += 1;
        }
      }
      if (count >= 50000) break;
    }
    if (count >= 50000) break;
  }
  context.decorations.forEach((decoration, index) => editor.setDecorations(decoration, ranges[index]));
  context.clearedDecorationEditors?.delete(editor);
  const uri = document.uri.toString();
  const startedAt = context.decorationStartTimes?.get(uri);
  if (startedAt !== undefined) {
    context.decorationStartTimes.delete(uri);
    console.info(`[AnyaCSV] Initial column colors applied in ${Date.now() - startedAt} ms.`);
  }
}

function markDecorationStart(document, context) {
  const uri = document.uri.toString();
  if (!context.decorationStartTimes.has(uri)) context.decorationStartTimes.set(uri, Date.now());
}

function updateVisibleDecorations(document, context) {
  const uri = document.uri.toString();
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.toString() === uri) updateDecorations(editor, context);
  }
}

async function showLint(context, resource) {
  const sourceUri = resource || vscode.window.activeTextEditor?.document.uri;
  if (sourceUri?.scheme === 'file') {
    const stat = await fs.promises.stat(sourceUri.fsPath).catch(error => {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      return undefined;
    });
    if (!stat) return;
    if (stat.size > LARGE_FILE_PREVIEW_THRESHOLD) {
      const uri = sourceUri.toString();
      const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri);
      const extension = path.extname(sourceUri.fsPath).toLowerCase();
      const languageId = document && (LANGUAGE_IDS.has(document.languageId) || extension === '.txt')
        ? document.languageId
        : (context.enabledDocuments.has(uri) && !FILE_EXTENSIONS.has(extension)
          ? 'plaintext'
          : largeCsvLanguageId(extension));
      const hasExplicitDelimiter = configuredDelimiter({ uri: sourceUri, languageId }, context) !== 'auto';
      const isTxtFile = extension === '.txt';
      const hasExplicitLanguageMode = document && LANGUAGE_IDS.has(document.languageId);
      if (isTxtFile && !context.enabledDocuments.has(uri) && !hasExplicitLanguageMode) {
        void vscode.window.showWarningMessage('Select an AnyaCSV language mode or enable AnyaCSV for this .txt file first.');
        return;
      }
      if (!FILE_EXTENSIONS.has(extension)
        && !isTxtFile
        && !context.enabledDocuments.has(uri)
        && !hasExplicitLanguageMode
        && !hasExplicitDelimiter) {
        void vscode.window.showWarningMessage('AnyaCSV could not identify this file as delimited data. Use “AnyaCSV: Enable for Current File” first.');
        return;
      }
      try {
        const model = await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: `Linting ${path.basename(sourceUri.fsPath)}`,
          cancellable: false
        }, progress => {
          let reportedBytes = 0;
          return buildLargeCsvTablePreview(sourceUri, context, languageId, (read, total) => {
            const increment = total ? 100 * (read - reportedBytes) / total : 0;
            reportedBytes = read;
            progress.report({ increment, message: total ? `${Math.min(100, Math.round(100 * read / total))}%` : undefined });
          });
        });
        if (model.lintIssueCount === 0) {
          void vscode.window.showInformationMessage(`${path.basename(sourceUri.fsPath)} has no CSV lint issues.`);
        } else {
          const firstIssues = model.lintIssues.slice(0, 3).map(issue => `Line ${issue.line}, column ${issue.column}: ${issue.message}`);
          const additionalCount = model.lintIssueCount - firstIssues.length;
          if (additionalCount > 0) firstIssues.push(`And ${additionalCount} more.`);
          void vscode.window.showWarningMessage(
            `${path.basename(sourceUri.fsPath)} has ${model.lintIssueCount.toLocaleString()} CSV lint issue${model.lintIssueCount === 1 ? '' : 's'}. ${firstIssues.join(' ')}`
          );
        }
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
      return;
    }
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor || !isCsvDocument(editor.document, context)) return;
  refreshDocument(editor.document, context);
  const diagnostics = context.diagnostics.get(editor.document.uri) || [];
  if (diagnostics.length === 0) {
    return;
  }
  const choices = diagnostics.map(diagnostic => ({
    label: `Line ${diagnostic.range.start.line + 1}: ${diagnostic.message}`,
    description: diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning',
    diagnostic
  }));
  const selected = await vscode.window.showQuickPick(choices, { placeHolder: 'AnyaCSV lint issues' });
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
const PREVIEW_PAGE_SIZES = [25, 50, 100, 200, 500];
const PREVIEW_MAX_COLUMNS = 200;

function getTablePreviewModel(document, parsed) {
  const config = vscode.workspace.getConfiguration('anyacsv', document.uri);
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
  const model = context.largePreviewModels.get(uri)
    || context.previewModels.get(uri)
    || (document ? getTablePreviewModel(document, getParsed(document, context)) : undefined);
  if (!model) return;
  const filteredRows = getFilteredTablePreviewRows(model, request);
  const pageSize = PREVIEW_PAGE_SIZES.includes(request.pageSize) ? request.pageSize : PREVIEW_PAGE_SIZE;
  const pageCount = Math.ceil(filteredRows.length / pageSize);
  const requestedPage = Number.isInteger(request.page) ? request.page : 0;
  const page = pageCount === 0 ? 0 : Math.min(Math.max(0, requestedPage), pageCount - 1);
  const rows = filteredRows
    .slice(page * pageSize, (page + 1) * pageSize)
    .map(({ row }) => Array.from(
      { length: model.columnCount },
      (_, index) => row.cells[index]?.value ?? ''
    ));
  panel.webview.postMessage({
    type: 'pageData',
    requestId: request.requestId,
    rows,
    page,
    pageSize,
    filteredRowCount: filteredRows.length,
    totalRowCount: model.sourceTotalRowCount ?? model.dataRows.length,
    previewedRowCount: model.dataRows.length,
    isPartial: model.isPartial === true
  });
}

function getFilteredTablePreviewRows(model, request = {}) {
  const globalTerm = typeof request.globalTerm === 'string'
    ? request.globalTerm.trim().toLocaleLowerCase()
    : '';
  const exactMatch = request.exactMatch === true;
  const columnTerms = Array.isArray(request.columnTerms)
    ? request.columnTerms
      .filter(item => item && Number.isInteger(item.index) && item.index >= 0 && item.index < model.columnCount && typeof item.term === 'string')
      .map(item => ({ index: item.index, term: item.term.trim().toLocaleLowerCase() }))
      .filter(item => item.term)
    : [];
  const filteredRows = model.dataRows.filter(({ row }) => {
    const matchesGlobal = !globalTerm || row.cells
      .slice(0, model.columnCount)
      .some(cell => exactMatch
        ? cell.value.toLocaleLowerCase() === globalTerm
        : cell.value.toLocaleLowerCase().includes(globalTerm));
    const matchesColumns = columnTerms.every(filter =>
      exactMatch
        ? (row.cells[filter.index]?.value ?? '').toLocaleLowerCase() === filter.term
        : (row.cells[filter.index]?.value ?? '').toLocaleLowerCase().includes(filter.term)
    );
    return matchesGlobal && matchesColumns;
  });
  return filteredRows;
}

const EXCEL_MAX_ROWS = 1048576;
const EXCEL_MAX_COLUMNS = 16384;
const ZIP32_MAX_VALUE = 0xffffffff;
const ZIP_CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function excelColumnName(columnNumber) {
  let number = columnNumber;
  let name = '';
  while (number > 0) {
    const remainder = (number - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    number = Math.floor((number - 1) / 26);
  }
  return name;
}

function escapeExcelText(value) {
  const text = String(value ?? '').replace(/_x([0-9a-f]{4})_/gi, '_x005F_x$1_');
  let escaped = '';
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code === 0x0d || code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff) {
      escaped += `_x${code.toString(16).toUpperCase().padStart(4, '0')}_`;
    } else if (character === '&') escaped += '&amp;';
    else if (character === '<') escaped += '&lt;';
    else if (character === '>') escaped += '&gt;';
    else if (character === '"') escaped += '&quot;';
    else if (character === "'") escaped += '&apos;';
    else escaped += character;
  }
  return escaped;
}

function* excelWorksheetRowXml(row, rowNumber) {
  yield `<row r="${rowNumber}">`;
  for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
    const cellReference = `${excelColumnName(columnIndex + 1)}${rowNumber}`;
    yield `<c r="${cellReference}" t="inlineStr"><is><t xml:space="preserve">${escapeExcelText(row[columnIndex])}</t></is></c>`;
  }
  yield '</row>';
}

function* excelWorksheetXml(headers, rows) {
  yield '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetData>';
  yield* excelWorksheetRowXml(headers, 1);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    yield* excelWorksheetRowXml(rows[rowIndex], rowIndex + 2);
  }
  yield '</sheetData>';
  if (rows.length > 0) yield `<autoFilter ref="A1:${excelColumnName(headers.length)}${rows.length + 1}"/>`;
  yield '</worksheet>';
}

function calculateZipCrc32(buffer) {
  let checksum = 0xffffffff;
  for (const byte of buffer) checksum = ZIP_CRC32_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  return (checksum ^ 0xffffffff) >>> 0;
}

function createZipLocalHeader(fileName, method, flags, checksum, compressedSize, uncompressedSize) {
  const name = Buffer.from(fileName, 'utf8');
  const header = Buffer.alloc(30 + name.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(flags, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0x0021, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(uncompressedSize, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  name.copy(header, 30);
  return header;
}

function createZipCentralHeader(entry) {
  const name = Buffer.from(entry.fileName, 'utf8');
  const header = Buffer.alloc(46 + name.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(entry.flags, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0x0021, 14);
  header.writeUInt32LE(entry.checksum, 16);
  header.writeUInt32LE(entry.compressedSize, 20);
  header.writeUInt32LE(entry.uncompressedSize, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(entry.localOffset, 42);
  name.copy(header, 46);
  return header;
}

function createExcelWorkbookArchive(headers, rows) {
  if (headers.length === 0) throw new Error('There are no columns to export.');
  if (headers.length > EXCEL_MAX_COLUMNS) throw new Error(`Excel supports at most ${EXCEL_MAX_COLUMNS.toLocaleString()} columns per worksheet.`);
  if (rows.length + 1 > EXCEL_MAX_ROWS) throw new Error(`Excel supports at most ${(EXCEL_MAX_ROWS - 1).toLocaleString()} data rows plus a header row per worksheet.`);
  const checkCellLength = value => {
    if (String(value ?? '').length > 32767) throw new Error('Excel supports at most 32,767 characters in a cell. Shorten the data and try again.');
  };
  headers.forEach(checkCellLength);
  rows.forEach(row => row.forEach(checkCellLength));
  return { headers, rows };
}

async function* excelWorkbookZipChunks(workbook) {
  const workbookParts = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="0"/><fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>']
  ];
  const centralEntries = [];
  let archiveOffset = 0;
  for (const [fileName, content] of workbookParts) {
    const data = Buffer.from(content, 'utf8');
    const checksum = calculateZipCrc32(data);
    const header = createZipLocalHeader(fileName, 0, 0x0800, checksum, data.length, data.length);
    const localOffset = archiveOffset;
    yield header;
    archiveOffset += header.length;
    yield data;
    archiveOffset += data.length;
    centralEntries.push({ fileName, method: 0, flags: 0x0800, checksum, compressedSize: data.length, uncompressedSize: data.length, localOffset });
  }

  const sheetFileName = 'xl/worksheets/sheet1.xml';
  const sheetFlags = 0x0808;
  const sheetLocalOffset = archiveOffset;
  const sheetHeader = createZipLocalHeader(sheetFileName, 8, sheetFlags, 0, 0, 0);
  yield sheetHeader;
  archiveOffset += sheetHeader.length;

  let checksumState = 0xffffffff;
  let uncompressedSize = 0;
  const checksumStream = new Transform({
    transform(chunk, encoding, callback) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      uncompressedSize += data.length;
      for (const byte of data) checksumState = ZIP_CRC32_TABLE[(checksumState ^ byte) & 0xff] ^ (checksumState >>> 8);
      callback(null, data);
    }
  });
  const deflater = createDeflateRaw();
  const compression = pipeline(Readable.from(excelWorksheetXml(workbook.headers, workbook.rows)), checksumStream, deflater);
  let compressedSize = 0;
  for await (const chunk of deflater) {
    compressedSize += chunk.length;
    archiveOffset += chunk.length;
    yield chunk;
  }
  await compression;
  const sheetChecksum = (checksumState ^ 0xffffffff) >>> 0;
  if (compressedSize > ZIP32_MAX_VALUE || uncompressedSize > ZIP32_MAX_VALUE || archiveOffset > ZIP32_MAX_VALUE) {
    throw new Error('The exported workbook is too large for this Excel file format.');
  }
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(sheetChecksum, 4);
  descriptor.writeUInt32LE(compressedSize, 8);
  descriptor.writeUInt32LE(uncompressedSize, 12);
  yield descriptor;
  archiveOffset += descriptor.length;
  centralEntries.push({ fileName: sheetFileName, method: 8, flags: sheetFlags, checksum: sheetChecksum, compressedSize, uncompressedSize, localOffset: sheetLocalOffset });

  const centralOffset = archiveOffset;
  for (const entry of centralEntries) {
    const centralHeader = createZipCentralHeader(entry);
    yield centralHeader;
    archiveOffset += centralHeader.length;
  }
  const centralSize = archiveOffset - centralOffset;
  if (archiveOffset > ZIP32_MAX_VALUE || centralSize > ZIP32_MAX_VALUE) throw new Error('The exported workbook is too large for this Excel file format.');
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(centralEntries.length, 8);
  endRecord.writeUInt16LE(centralEntries.length, 10);
  endRecord.writeUInt32LE(centralSize, 12);
  endRecord.writeUInt32LE(centralOffset, 16);
  endRecord.writeUInt16LE(0, 20);
  yield endRecord;
}

async function writeExcelArchive(target, workbook) {
  const zipStream = Readable.from(excelWorkbookZipChunks(workbook));
  if (target.scheme !== 'file') {
    const chunks = [];
    for await (const chunk of zipStream) chunks.push(chunk);
    await vscode.workspace.fs.writeFile(target, Buffer.concat(chunks));
    return;
  }

  const temporaryPath = path.join(path.dirname(target.fsPath), `.${path.basename(target.fsPath)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    await pipeline(zipStream, fs.createWriteStream(temporaryPath, { flags: 'wx' }));
    await fs.promises.rename(temporaryPath, target.fsPath);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function exportTablePreviewForExcel(sourceUri, model, request) {
  const filteredRows = getFilteredTablePreviewRows(model, request);
  const rows = filteredRows.map(({ row }) => Array.from(
    { length: model.columnCount },
    (_, index) => row.cells[index]?.value ?? ''
  ));
  const sourcePath = sourceUri.scheme === 'file' ? sourceUri.fsPath : '';
  const sourceName = sourcePath ? path.basename(sourcePath, path.extname(sourcePath)) : 'data';
  const defaultUri = sourcePath
    ? vscode.Uri.file(path.join(path.dirname(sourcePath), `${sourceName}_export.xlsx`))
    : undefined;
  const target = await vscode.window.showSaveDialog({
    defaultUri,
    saveLabel: 'Export to Excel',
    filters: { 'Excel workbooks': ['xlsx'] }
  });
  if (!target) return;
  await writeExcelArchive(target, createExcelWorkbookArchive(model.headers, rows));
  void vscode.window.showInformationMessage(`Exported ${rows.length.toLocaleString()} rows to an Excel workbook.`);
}

function buildTablePreviewHtml(document, parsed, modelOverride) {
  const { dataRows, sourceColumnCount, columnCount, headers } = modelOverride || getTablePreviewModel(document, parsed);
  const tableHeader = headers.map((name, index) => `
      <th scope="col">
        <div class="column-name">${escapeHtml(name)}</div>
        <input class="column-filter" type="search" data-column="${index}" aria-label="Filter ${escapeHtml(name)}" placeholder="Filter column…">
      </th>`).join('');
  const totalRowCount = modelOverride?.sourceTotalRowCount ?? dataRows.length;
  const description = modelOverride?.isLargeFile
    ? `${dataRows.length.toLocaleString()} loaded of ${totalRowCount.toLocaleString()} rows · delimiter: ${printableDelimiter(parsed.delimiter)}`
    : `${dataRows.length.toLocaleString()} rows · delimiter: ${printableDelimiter(parsed.delimiter)}`;
  const columnNote = sourceColumnCount > PREVIEW_MAX_COLUMNS
    ? `<p class="description">Showing the first ${PREVIEW_MAX_COLUMNS} of ${sourceColumnCount.toLocaleString()} columns.</p>`
    : '';
  const largeFileNote = modelOverride?.isLargeFile
    ? `<p class="description">Large-file preview reads the saved file from disk. ${modelOverride.isPartial
      ? 'Filtering covers the loaded rows only; Excel export is unavailable for a partial preview.'
      : 'All rows are loaded. Save changes before refreshing the preview.'}</p>`
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
    body { display: flex; flex-direction: column; height: 100vh; margin: 0; overflow: hidden; padding: 0 18px 12px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); }
    .title-bar { display: flex; align-items: center; gap: 12px; }
    .title-bar h1 { margin: 18px 0 12px; font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
    .title-actions { display: flex; align-items: center; gap: 4px; margin-left: auto; flex: 0 0 auto; }
    .icon-button { display: inline-grid; place-items: center; width: 30px; height: 30px; padding: 5px; color: var(--vscode-icon-foreground, var(--vscode-foreground)); background: transparent; border: 1px solid transparent; border-radius: 4px; cursor: pointer; }
    .icon-button:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    .icon-button:disabled { opacity: .45; cursor: default; }
    .icon-button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    .title-actions .excel-export-button { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 4px 9px; color: #fff; background: #217346; border: 1px solid #185c37; border-radius: 4px; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
    .title-actions .excel-export-button:hover { background: #185c37; }
    .title-actions .excel-export-button:disabled { opacity: .45; cursor: default; }
    .title-actions .excel-export-button:hover:disabled { background: #217346; }
    .title-actions .icon-button[data-exact-match="true"] { background: var(--vscode-toolbar-activeBackground, var(--vscode-list-activeSelectionBackground)); border-color: var(--vscode-focusBorder); }
    .excel-mark { display: inline-grid; place-items: center; width: 17px; height: 17px; border: 1px solid rgba(255,255,255,.8); border-radius: 2px; font-size: 11px; line-height: 1; font-weight: 700; }
    #window-action[data-window-mode="poppedOut"] .pop-in-icon { display: block; }
    #window-action[data-window-mode="poppedOut"] .pop-out-icon { display: none; }
    .pop-in-icon { display: none; }
    .toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
    #global-filter, .column-filter, select, button { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; padding: 5px 7px; font: inherit; }
    #global-filter { width: min(360px, 100%); }
    #global-filter:focus, .column-filter:focus, select:focus, button:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    #result-count { margin-left: auto; opacity: .8; white-space: nowrap; }
    .refresh-warning { display: flex; align-items: center; gap: 10px; margin: 0 0 10px; padding: 8px 10px; color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); background: var(--vscode-inputValidation-warningBackground, var(--vscode-editor-background)); border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border)); }
    .refresh-warning[hidden] { display: none; }
    .refresh-warning-message { flex: 1 1 auto; }
    .description { margin: 0 0 12px; opacity: .8; }
    .table-pagination { display: flex; flex: 0 0 auto; align-items: center; justify-content: flex-end; gap: 8px; margin: 0 0 8px; }
    .pagination { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin: 0; }
    .page-size-control { margin: 4px 0 0; }
    .page-info { flex: 0 0 auto; margin: 0; text-align: right; opacity: .85; }
    .pagination button { display: inline-grid; place-items: center; width: 30px; height: 30px; padding: 5px; color: var(--vscode-icon-foreground, var(--vscode-foreground)); background: transparent; border: 1px solid transparent; border-radius: 4px; cursor: pointer; }
    .pagination button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    .pagination button:disabled { opacity: .45; cursor: default; }
    .pagination button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    #page-status { min-width: 90px; }
    .table-scroll { flex: 1 1 auto; min-height: 0; max-width: 100%; overflow: auto; border: 1px solid var(--vscode-panel-border, #888); }
    table { width: max-content; min-width: 100%; border-collapse: separate; border-spacing: 0; table-layout: fixed; }
    th, td { min-width: 160px; max-width: 360px; padding: 7px 9px; text-align: left; vertical-align: top; border-right: 1px solid var(--vscode-panel-border, #888); border-bottom: 1px solid var(--vscode-panel-border, #888); overflow-wrap: anywhere; }
    th.row-number, td.row-number { min-width: 54px; width: 54px; text-align: right; color: var(--vscode-descriptionForeground); }
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
  <div class="title-bar">
    <h1>${escapeHtml(fileName)}</h1>
    <div class="title-actions">
      <button id="export-excel" class="excel-export-button" type="button"${modelOverride?.isPartial ? ' disabled title="Export is unavailable for a partial large-file preview" aria-label="Export is unavailable for a partial large-file preview"' : ' title="Export all filtered rows as an Excel workbook (.xlsx)" aria-label="Export all filtered rows as an Excel workbook (.xlsx)"'}><span class="excel-mark" aria-hidden="true">X</span><span>Export</span></button>
      <button id="exact-filter" class="icon-button" data-exact-match="false" type="button" aria-pressed="false" title="Exact filtering off" aria-label="Exact filtering off"${columnCount === 0 ? ' disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v5l-4 2v-7z"/><path d="M16 17h6M16 20h6"/></svg></button>
      <button id="refresh-preview" class="icon-button" type="button" title="Refresh preview" aria-label="Refresh preview"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-4L3 10"/><path d="M3 4v6h6"/><path d="M4 13a8 8 0 0 0 14.9 4L21 14"/><path d="M21 20v-6h-6"/></svg></button>
      <button id="window-action" class="icon-button" data-window-mode="main" type="button" title="Pop out preview" aria-label="Pop out preview"><svg class="pop-out-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/></svg><svg class="pop-in-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 3 12 12"/><path d="M12 6v6h6"/><path d="M15 12v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h7"/></svg></button>
    </div>
  </div>
  <div class="toolbar">
    <input id="global-filter" type="search" aria-label="Filter all columns" placeholder="Filter all columns…"${columnCount === 0 ? ' disabled' : ''}>
    <span id="result-count" aria-live="polite"></span>
  </div>
  <div id="refresh-warning" class="refresh-warning" role="status" hidden>
    <span id="refresh-warning-message" class="refresh-warning-message"></span>
    <button id="retry-redetect" type="button">Retry / re-detect delimiter</button>
  </div>
  <p class="description">${escapeHtml(description)}</p>
  ${columnNote}
  ${largeFileNote}
  ${columnCount === 0 ? '<p class="empty">No delimited data to preview.</p>' : `
  <div class="table-pagination">
    <div class="page-info"><span id="page-status" aria-live="polite">Loading…</span></div>
    <div class="pagination" aria-label="Table pagination">
      <button id="previous-page" type="button" title="Previous page" aria-label="Previous page" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 18l-6-6 6-6"/></svg></button>
      <button id="next-page" type="button" title="Next page" aria-label="Next page" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 18l6-6-6-6"/></svg></button>
    </div>
  </div>
  <div class="table-scroll">
    <table>
      <thead><tr><th class="row-number" scope="col">#</th>${tableHeader}</tr></thead>
      <tbody id="preview-rows"><tr><td colspan="${columnCount + 1}">Loading…</td></tr></tbody>
    </table>
  </div>`}
  ${columnCount > 0 ? `
  <div class="pagination page-size-control">
    <label for="page-size">Rows per page</label>
    <select id="page-size" aria-label="Rows per page">${PREVIEW_PAGE_SIZES.map(size => `<option value="${size}"${size === PREVIEW_PAGE_SIZE ? ' selected' : ''}>${size}</option>`).join('')}</select>
  </div>` : ''}
  <script nonce="${nonce}">
    (() => {
      const globalFilter = document.getElementById('global-filter');
      const columnFilters = [...document.querySelectorAll('.column-filter')];
      const count = document.getElementById('result-count');
      const refreshWarning = document.getElementById('refresh-warning');
      const refreshWarningMessage = document.getElementById('refresh-warning-message');
      const retryRedetect = document.getElementById('retry-redetect');
      const exportButton = document.getElementById('export-excel');
      const pageSizeSelect = document.getElementById('page-size');
      const windowAction = document.getElementById('window-action');
      const exactFilter = document.getElementById('exact-filter');
      const api = acquireVsCodeApi();
      let exactMatch = false;
      const updateExactFilter = () => {
        const label = exactMatch ? 'Exact filtering on' : 'Exact filtering off';
        exactFilter.dataset.exactMatch = String(exactMatch);
        exactFilter.setAttribute('aria-pressed', String(exactMatch));
        exactFilter.title = label;
        exactFilter.setAttribute('aria-label', label);
      };
      windowAction.addEventListener('click', () => {
        windowAction.disabled = true;
        api.postMessage({ type: 'windowAction' });
      });
      document.getElementById('refresh-preview').addEventListener('click', () => api.postMessage({ type: 'refresh' }));
      retryRedetect.addEventListener('click', () => {
        retryRedetect.disabled = true;
        api.postMessage({ type: 'refresh', redetect: true });
      });
      document.getElementById('export-excel').addEventListener('click', () => {
        const columnTerms = columnFilters
          .map(input => ({ index: Number(input.dataset.column), term: input.value }))
          .filter(filter => filter.term.trim());
        api.postMessage({ type: 'export', globalTerm: globalFilter.value, columnTerms, exactMatch });
      });
      window.addEventListener('message', event => {
        const message = event.data;
        if (message?.type === 'windowMode') {
          const isPoppedOut = message.mode === 'poppedOut';
          windowAction.dataset.windowMode = isPoppedOut ? 'poppedOut' : 'main';
          windowAction.title = isPoppedOut ? 'Pop in preview' : 'Pop out preview';
          windowAction.setAttribute('aria-label', windowAction.title);
          windowAction.disabled = false;
        } else if (message?.type === 'refreshError') {
          refreshWarningMessage.textContent = message.message;
          refreshWarning.hidden = false;
          retryRedetect.disabled = false;
          exportButton.disabled = true;
        } else if (message?.type === 'windowActionError') {
          windowAction.disabled = false;
        }
      });
      api.postMessage({ type: 'ready' });
      if (${columnCount > 0}) {
        const body = document.getElementById('preview-rows');
        const previous = document.getElementById('previous-page');
        const next = document.getElementById('next-page');
        const pageStatus = document.getElementById('page-status');
        let currentPage = 0;
        let requestId = 0;
        let filterTimer;
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
            pageSize: Number(pageSizeSelect.value),
            globalTerm: globalFilter.value,
            columnTerms,
            exactMatch
          });
        }
        exactFilter.addEventListener('click', () => {
          exactMatch = !exactMatch;
          updateExactFilter();
          requestPage(0);
        });
        window.addEventListener('message', event => {
          const message = event.data;
          if (!message || message.type !== 'pageData' || message.requestId !== requestId) return;
          currentPage = message.page;
          const fragment = document.createDocumentFragment();
          for (const values of message.rows) {
            const row = document.createElement('tr');
            const number = document.createElement('th');
            number.className = 'row-number';
            number.scope = 'row';
            number.textContent = (currentPage * message.pageSize + fragment.childElementCount + 1).toLocaleString();
            row.appendChild(number);
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
            cell.colSpan = ${columnCount + 1};
            cell.textContent = 'No rows match these filters.';
            row.appendChild(cell);
            fragment.appendChild(row);
          }
          body.replaceChildren(fragment);
          count.textContent = message.isPartial
            ? message.filteredRowCount.toLocaleString() + ' matching / ' + message.previewedRowCount.toLocaleString() + ' loaded of ' + message.totalRowCount.toLocaleString() + ' rows'
            : message.filteredRowCount.toLocaleString() + ' matching / ' + message.totalRowCount.toLocaleString() + ' rows';
          const pageCount = Math.ceil(message.filteredRowCount / message.pageSize);
          pageStatus.textContent = pageCount
            ? 'Page ' + (currentPage + 1).toLocaleString() + ' of ' + pageCount.toLocaleString() + ' · ' + message.filteredRowCount.toLocaleString() + (message.isPartial ? ' loaded matching rows' : ' rows')
            : 'Page 0 of 0 · 0 rows';
          previous.disabled = currentPage <= 0;
          next.disabled = currentPage + 1 >= pageCount;
        });
        function scheduleFilter() {
          clearTimeout(filterTimer);
          filterTimer = setTimeout(() => requestPage(0), 150);
        }
        previous.addEventListener('click', () => requestPage(currentPage - 1));
        next.addEventListener('click', () => requestPage(currentPage + 1));
        globalFilter.addEventListener('input', scheduleFilter);
        columnFilters.forEach(input => input.addEventListener('input', scheduleFilter));
        pageSizeSelect.addEventListener('change', () => requestPage(0));
        requestPage(0);
      }
    })();
  </script>
</body>
</html>`;
}

function postPreviewRefreshError(context, uri, error) {
  const panel = context.previewPanels.get(uri);
  if (!panel) return;
  const reason = error instanceof Error ? error.message : String(error);
  const isRecognitionFailure = reason.includes('no longer recognized as delimited data')
    || reason.includes('could not identify this file as delimited data');
  const message = isRecognitionFailure
    ? `The source is no longer recognized as delimited data. It may have been edited or emptied. Your previous table is still shown.`
    : `Refresh failed: ${reason} Your previous table is still shown.`;
  void panel.webview.postMessage({ type: 'refreshError', message });
}

function refreshTablePreview(document, context, options = {}) {
  const uri = document.uri.toString();
  const panel = context.previewPanels.get(uri);
  if (!panel) return false;

  const previousDelimiter = context.previewDelimiters.get(uri);
  const canReuseDelimiter = !options.redetect
    && previousDelimiter
    && previousDelimiter.version === context.previewDelimiterVersion;
  if (!canReuseDelimiter && !isCsvDocument(document, context)) {
    if (previousDelimiter) {
      postPreviewRefreshError(context, uri, new Error('The source is no longer recognized as delimited data.'));
    }
    return false;
  }

  try {
    let parsed = getParsed(document, context, canReuseDelimiter
      ? { delimiter: previousDelimiter.delimiter, autoDetected: previousDelimiter.autoDetected }
      : {});
    let hasMultipleColumns = parsed.rows.some(row => row.cells.length > 1);
    const cachedDelimiterNoLongerFits = canReuseDelimiter
      && previousDelimiter.recognized
      && !hasMultipleColumns;
    if (cachedDelimiterNoLongerFits && parsed.requested === 'auto' && parsed.autoDetect) {
      const redetected = getParsed(document, context);
      const redetectedHasMultipleColumns = redetected.rows.some(row => row.cells.length > 1);
      if (redetected.autoDetected || redetectedHasMultipleColumns) {
        parsed = redetected;
        hasMultipleColumns = redetectedHasMultipleColumns;
      }
    }

    const detectionFailed = previousDelimiter?.recognized
      && parsed.requested === 'auto'
      && parsed.autoDetect
      && !parsed.autoDetected
      && !hasMultipleColumns;
    if (detectionFailed || (cachedDelimiterNoLongerFits && !hasMultipleColumns)) {
      throw new Error('The source is no longer recognized as delimited data.');
    }

    context.previewDelimiters.set(uri, {
      delimiter: parsed.delimiter,
      autoDetected: parsed.autoDetected,
      recognized: hasMultipleColumns,
      version: context.previewDelimiterVersion
    });
    const model = getTablePreviewModel(document, parsed);
    context.previewModels.set(uri, model);
    panel.webview.html = buildTablePreviewHtml(document, parsed, model);
    return true;
  } catch (error) {
    postPreviewRefreshError(context, uri, error);
    return false;
  }
}

async function showTablePreview(context, resource) {
  const activeDocument = vscode.window.activeTextEditor?.document;
  const sourceUri = resource || activeDocument?.uri;
  if (!sourceUri) return;
  const uri = sourceUri.toString();
  const fileExtension = path.extname(sourceUri.fsPath || sourceUri.path || '').toLowerCase();
  const fileName = path.basename(sourceUri.fsPath || sourceUri.path || '') || 'CSV Table';
  let document = activeDocument?.uri.toString() === uri ? activeDocument : undefined;
  let largeModel;
  let parsed;
  let previewModel;
  const sourceLanguageId = document && (LANGUAGE_IDS.has(document.languageId) || fileExtension === '.txt')
    ? document.languageId
    : (context.enabledDocuments.has(uri) && !FILE_EXTENSIONS.has(fileExtension)
      ? 'plaintext'
      : largeCsvLanguageId(fileExtension));
  try {
    let fileSize = 0;
    if (sourceUri.scheme === 'file') fileSize = (await fs.promises.stat(sourceUri.fsPath)).size;
    const isLargeFile = sourceUri.scheme === 'file' && fileSize > LARGE_FILE_PREVIEW_THRESHOLD;
    if (isLargeFile) {
      const largeDocument = { uri: sourceUri, languageId: sourceLanguageId };
      const hasExplicitDelimiter = configuredDelimiter(largeDocument, context) !== 'auto';
      const isTxtFile = fileExtension === '.txt';
      const hasExplicitLanguageMode = document && LANGUAGE_IDS.has(document.languageId);
      if (isTxtFile && !context.enabledDocuments.has(uri) && !hasExplicitLanguageMode) {
        vscode.window.showWarningMessage('Select an AnyaCSV language mode or enable AnyaCSV for this .txt file first.');
        return;
      }
      if (!FILE_EXTENSIONS.has(fileExtension)
        && !isTxtFile
        && !context.enabledDocuments.has(uri)
        && !hasExplicitLanguageMode
        && !hasExplicitDelimiter) {
        vscode.window.showWarningMessage('AnyaCSV could not identify this file as delimited data. Use “AnyaCSV: Enable for Current File” first.');
        return;
      }
      largeModel = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Reading ${fileName} for AnyaCSV preview`,
        cancellable: false
      }, progress => {
        let reportedBytes = 0;
        return buildLargeCsvTablePreview(sourceUri, context, sourceLanguageId, (read, total) => {
          const increment = total ? 100 * (read - reportedBytes) / total : 0;
          reportedBytes = read;
          progress.report({ increment, message: total ? `${Math.min(100, Math.round(100 * read / total))}%` : undefined });
        });
      });
      context.largePreviewModels.set(uri, largeModel);
      context.previewModels.delete(uri);
      context.previewDelimiters.set(uri, {
        delimiter: largeModel.delimiter,
        autoDetected: largeModel.autoDetected,
        recognized: largeModel.hasMultipleColumns,
        version: context.previewDelimiterVersion
      });
      context.previewSourceUris.set(uri, sourceUri);
    } else {
      if (!document) {
        document = resource ? await vscode.workspace.openTextDocument(resource) : activeDocument;
      }
      if (!document) return;
      if (!isCsvDocument(document, context)) {
        vscode.window.showWarningMessage('AnyaCSV could not identify this file as delimited data. Use “AnyaCSV: Enable for Current File” first.');
        return;
      }
      parsed = getParsed(document, context);
      context.largePreviewModels.delete(uri);
      previewModel = getTablePreviewModel(document, parsed);
      context.previewModels.set(uri, previewModel);
      context.previewDelimiters.set(uri, {
        delimiter: parsed.delimiter,
        autoDetected: parsed.autoDetected,
        recognized: parsed.rows.some(row => row.cells.length > 1),
        version: context.previewDelimiterVersion
      });
      context.previewSourceUris.set(uri, sourceUri);
    }
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    return;
  }

  let panel = context.previewPanels.get(uri);
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      'anyacsv.tablePreview',
      'AnyaCSV Table Preview',
      vscode.ViewColumn.Beside,
      { enableScripts: true, localResourceRoots: [] }
    );
    context.previewPanels.set(uri, panel);
    context.previewWindowModes.set(uri, 'main');
    const messageListener = panel.webview.onDidReceiveMessage(message => {
      if (message?.type === 'query') sendTablePreviewPage(uri, panel, context, message);
      if (message?.type === 'ready') {
        void panel.webview.postMessage({ type: 'windowMode', mode: context.previewWindowModes.get(uri) || 'main' });
      }
      if (message?.type === 'windowAction') {
        const currentMode = context.previewWindowModes.get(uri) || 'main';
        const isPoppedOut = currentMode === 'poppedOut';
        const command = isPoppedOut
          ? 'workbench.action.restoreEditorsToMainWindow'
          : 'workbench.action.moveEditorToNewWindow';
        void vscode.commands.executeCommand(command).then(() => {
          const nextMode = isPoppedOut ? 'main' : 'poppedOut';
          context.previewWindowModes.set(uri, nextMode);
          void panel.webview.postMessage({ type: 'windowMode', mode: nextMode });
        }, error => {
          vscode.window.showErrorMessage(`Could not ${isPoppedOut ? 'pop in' : 'pop out'} the CSV preview: ${error instanceof Error ? error.message : String(error)}`);
          void panel.webview.postMessage({ type: 'windowActionError' });
        });
      }
      if (message?.type === 'export') {
        const sourceDocument = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri);
        const model = context.largePreviewModels.get(uri)
          || context.previewModels.get(uri)
          || (sourceDocument ? getTablePreviewModel(sourceDocument, getParsed(sourceDocument, context)) : undefined);
        const exportUri = context.previewSourceUris.get(uri) || sourceDocument?.uri;
        if (!model || !exportUri) {
          void vscode.window.showErrorMessage('The source document is no longer open.');
          return;
        }
        if (model.isPartial) return;
        try {
          void exportTablePreviewForExcel(exportUri, model, message)
            .catch(error => vscode.window.showErrorMessage(`Could not export Excel workbook: ${error instanceof Error ? error.message : String(error)}`));
        } catch (error) {
          void vscode.window.showErrorMessage(`Could not export Excel workbook: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (message?.type === 'refresh') {
        const largeSourceUri = context.previewSourceUris.get(uri);
        if (context.largePreviewModels.has(uri) && largeSourceUri) {
          const previousDelimiter = context.previewDelimiters.get(uri);
          const canReuseDelimiter = !message.redetect
            && previousDelimiter
            && previousDelimiter.version === context.previewDelimiterVersion;
          const largeDocument = { uri: largeSourceUri, languageId: sourceLanguageId };
          const canAutoDetect = configuredDelimiter(largeDocument, context) === 'auto'
            && vscode.workspace.getConfiguration('anyacsv', largeSourceUri).get('autoDetect', true);
          void vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Refreshing ${fileName} AnyaCSV preview`,
            cancellable: false
          }, progress => {
            const build = (options, progressWeight) => {
              let reportedBytes = 0;
              return buildLargeCsvTablePreview(largeSourceUri, context, sourceLanguageId, (read, total) => {
                const increment = total ? progressWeight * (read - reportedBytes) / total : 0;
                reportedBytes = read;
                progress.report({ increment, message: total ? `${Math.min(100, Math.round(100 * read / total))}%` : undefined });
              }, options);
            };
            const firstOptions = canReuseDelimiter
              ? { delimiter: previousDelimiter.delimiter, autoDetected: previousDelimiter.autoDetected }
              : {};
            return build(firstOptions, canReuseDelimiter ? 50 : 100).then(async firstResult => {
              if (canReuseDelimiter
                && previousDelimiter.recognized
                && !firstResult.hasMultipleColumns
                && canAutoDetect) {
                progress.report({ message: 'Cached delimiter no longer fits; re-detecting…' });
                return build({}, 50);
              }
              if (canReuseDelimiter) progress.report({ increment: 50 });
              return firstResult;
            });
          }).then(refreshed => {
            if (previousDelimiter?.recognized && !refreshed.hasMultipleColumns) {
              throw new Error('The source is no longer recognized as delimited data.');
            }
            context.largePreviewModels.set(uri, refreshed);
            context.previewDelimiters.set(uri, {
              delimiter: refreshed.delimiter,
              autoDetected: refreshed.autoDetected,
              recognized: refreshed.hasMultipleColumns,
              version: context.previewDelimiterVersion
            });
            panel.webview.html = buildTablePreviewHtml({ uri: largeSourceUri }, { delimiter: refreshed.delimiter }, refreshed);
          }).catch(error => postPreviewRefreshError(context, uri, error));
          return;
        }
        const sourceDocument = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri);
        if (!sourceDocument) {
          postPreviewRefreshError(context, uri, new Error('The source document is no longer open.'));
        } else {
          refreshTablePreview(sourceDocument, context, { redetect: Boolean(message.redetect) });
        }
      }
    });
    context.hostSubscriptions.push(messageListener);
    context.hostSubscriptions.push(panel.onDidDispose(() => {
      messageListener.dispose();
      context.previewPanels.delete(uri);
      context.largePreviewModels.delete(uri);
      context.previewModels.delete(uri);
      context.previewDelimiters.delete(uri);
      context.previewSourceUris.delete(uri);
      context.previewWindowModes.delete(uri);
    }));
  }
  panel.title = `AnyaCSV: ${fileName}`;
  if (largeModel) {
    panel.webview.html = buildTablePreviewHtml({ uri: sourceUri }, { delimiter: largeModel.delimiter }, largeModel);
  } else if (document) {
    const initialParsed = parsed || getParsed(document, context);
    previewModel ||= getTablePreviewModel(document, initialParsed);
    context.previewModels.set(uri, previewModel);
    panel.webview.html = buildTablePreviewHtml(document, initialParsed, previewModel);
  }
  panel.reveal(vscode.ViewColumn.Beside);
  // Webview panels open as preview (italic) tabs, which the next opened file replaces.
  // Pin the panel so a large-file preview is not discarded and re-read.
  if (panel.active) await vscode.commands.executeCommand('workbench.action.keepEditor');
}

async function applyDocumentDelimiter(document, delimiter, extensionContext, hostContext) {
  const normalized = delimiter === '\\t' ? '\t' : delimiter;
  if (!normalized) {
    vscode.window.showErrorMessage('AnyaCSV delimiter cannot be empty.');
    return false;
  }
  if (/[\r\n]/.test(normalized)) {
    vscode.window.showErrorMessage('AnyaCSV separators cannot contain line breaks.');
    return false;
  }
  const uri = document.uri.toString();
  extensionContext.enabledDocuments.add(uri);
  await hostContext.globalState.update('enabledDocuments', [...extensionContext.enabledDocuments]);
  await extensionContext.workspaceState.update(`delimiter:${uri}`, normalized);
  extensionContext.previewDelimiterVersion += 1;
  extensionContext.parseCache.delete(uri);
  refreshDocument(document, extensionContext);
  extensionContext.semanticTokensChangeEmitter.fire();
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
  const diagnostics = vscode.languages.createDiagnosticCollection('anyacsv');
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  const semanticTokensChangeEmitter = new vscode.EventEmitter();
  const semanticTokensLegend = new vscode.SemanticTokensLegend(COLUMN_TOKEN_TYPES);
  const decorations = COLOR_IDS.map(color => vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor(color),
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  }));
  const extensionContext = {
    diagnostics,
    statusBar,
    semanticTokensChangeEmitter,
    clearedDecorationEditors: new WeakSet(),
    decorations,
    hostSubscriptions: context.subscriptions,
    enabledDocuments: new Set(context.globalState.get('enabledDocuments', [])),
    parseCache: new Map(),
    timers: new Map(),
    previewPanels: new Map(),
    largePreviewModels: new Map(),
    previewModels: new Map(),
    previewDelimiters: new Map(),
    previewDelimiterVersion: 0,
    previewSourceUris: new Map(),
    previewWindowModes: new Map(),
    lastLanguageByUri: new Map(),
    decorationStartTimes: new Map(),
    workspaceState: context.workspaceState
  };
  statusBar.command = 'anyacsv.showLint';
  context.subscriptions.push(diagnostics, statusBar, semanticTokensChangeEmitter, ...decorations);

  context.subscriptions.push(vscode.languages.registerDocumentRangeSemanticTokensProvider('dynamic csv', {
    onDidChangeSemanticTokens: semanticTokensChangeEmitter.event,
    provideDocumentRangeSemanticTokens(document, range) {
      return provideDynamicCsvSemanticTokens(document, range, extensionContext, semanticTokensLegend);
    }
  }, semanticTokensLegend));

  context.subscriptions.push(vscode.languages.registerHoverProvider({ scheme: '*' }, {
    provideHover(document, position) {
      if (!isCsvDocument(document, extensionContext)) return undefined;
      const parsed = getParsed(document, extensionContext);
      const found = findCell(document, parsed, position);
      if (!found) return undefined;
      const name = getColumnName(document, parsed, found.rowIndex, found.columnIndex, extensionContext);
      const headerRow = vscode.workspace.getConfiguration('anyacsv', document.uri).get('headerRow', 1);
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

  context.subscriptions.push(vscode.commands.registerCommand('anyacsv.enableForCurrentFile', async () => {
    const document = vscode.window.activeTextEditor?.document;
    if (!document) return;
    extensionContext.enabledDocuments.add(document.uri.toString());
    await context.globalState.update('enabledDocuments', [...extensionContext.enabledDocuments]);
    refreshDocument(document, extensionContext);
    updateDecorations(vscode.window.activeTextEditor, extensionContext);
    vscode.window.showInformationMessage(`AnyaCSV enabled for ${path.basename(document.uri.fsPath) || document.uri.toString()}.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('anyacsv.setDelimiter', async () => {
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

  context.subscriptions.push(vscode.commands.registerCommand('anyacsv.setDelimiterFromSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const delimiter = editor.document.getText(editor.selection);
    if (!delimiter) {
      vscode.window.showErrorMessage('Select the separator text first, then run this command.');
      return;
    }
    await applyDocumentDelimiter(editor.document, delimiter, extensionContext, context);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('anyacsv.autoDetectDelimiter', async () => {
    const document = vscode.window.activeTextEditor?.document;
    if (!document) return;
    extensionContext.enabledDocuments.add(document.uri.toString());
    await context.globalState.update('enabledDocuments', [...extensionContext.enabledDocuments]);
    await extensionContext.workspaceState.update(`delimiter:${document.uri.toString()}`, 'auto');
    extensionContext.previewDelimiterVersion += 1;
    extensionContext.parseCache.delete(document.uri.toString());
    refreshDocument(document, extensionContext);
    extensionContext.semanticTokensChangeEmitter.fire();
    refreshTablePreview(document, extensionContext);
    updateDecorations(vscode.window.activeTextEditor, extensionContext);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('anyacsv.showLint', resource => showLint(extensionContext, resource)));
  context.subscriptions.push(vscode.commands.registerCommand('anyacsv.previewTable', resource => showTablePreview(extensionContext, resource)));
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
    observeLanguage(document, extensionContext, context);
    if (vscode.window.visibleTextEditors.some(editor => editor.document.uri.toString() === document.uri.toString())) {
      markDecorationStart(document, extensionContext);
    }
    refreshDocument(document, extensionContext);
    updateVisibleDecorations(document, extensionContext);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    const uri = event.document.uri.toString();
    const oldTimer = extensionContext.timers.get(uri);
    if (oldTimer) clearTimeout(oldTimer);
    extensionContext.timers.set(uri, setTimeout(() => {
      extensionContext.parseCache.delete(uri);
      refreshDocument(event.document, extensionContext);
      if (!extensionContext.largePreviewModels.has(uri)) refreshTablePreview(event.document, extensionContext);
      updateVisibleDecorations(event.document, extensionContext);
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
    if (event.affectsConfiguration('anyacsv')) {
      extensionContext.previewDelimiterVersion += 1;
      extensionContext.parseCache.clear();
      vscode.workspace.textDocuments.forEach(document => {
        refreshDocument(document, extensionContext);
        if (!extensionContext.largePreviewModels.has(document.uri.toString())) refreshTablePreview(document, extensionContext);
      });
      extensionContext.semanticTokensChangeEmitter.fire();
      vscode.window.visibleTextEditors.forEach(editor => updateDecorations(editor, extensionContext));
      updateStatus(extensionContext);
    }
  }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor) {
      observeLanguage(editor.document, extensionContext, context);
      markDecorationStart(editor.document, extensionContext);
      refreshDocument(editor.document, extensionContext);
    } else {
      vscode.commands.executeCommand('setContext', 'anyacsv.isDelimited', false);
    }
    updateDecorations(editor, extensionContext);
    updateStatus(extensionContext);
  }));

  context.subscriptions.push(vscode.window.onDidChangeTextEditorVisibleRanges(event => {
    updateDecorations(event.textEditor, extensionContext);
  }));

  const activeEditor = vscode.window.activeTextEditor;
  const initializedDocuments = new Set();
  if (activeEditor) {
    observeLanguage(activeEditor.document, extensionContext, context);
    markDecorationStart(activeEditor.document, extensionContext);
    refreshDocument(activeEditor.document, extensionContext);
    updateDecorations(activeEditor, extensionContext);
    initializedDocuments.add(activeEditor.document.uri.toString());
  }
  vscode.window.visibleTextEditors.forEach(editor => {
    const uri = editor.document.uri.toString();
    if (initializedDocuments.has(uri)) return;
    observeLanguage(editor.document, extensionContext, context);
    refreshDocument(editor.document, extensionContext);
    updateDecorations(editor, extensionContext);
    initializedDocuments.add(uri);
  });
  setTimeout(() => {
    vscode.workspace.textDocuments.forEach(document => {
      const uri = document.uri.toString();
      if (initializedDocuments.has(uri)) return;
      observeLanguage(document, extensionContext, context);
      refreshDocument(document, extensionContext);
      initializedDocuments.add(uri);
    });
  }, 0);
  updateStatus(extensionContext);
}

function deactivate() {}

module.exports = { activate, deactivate, parseDelimited, detectDelimiter, findCell, getFilteredTablePreviewRows, buildLargeCsvTablePreview, refreshTablePreview, updateDecorations, provideDynamicCsvSemanticTokens };
