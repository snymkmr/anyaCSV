# AnyCSV

AnyCSV brings delimiter-aware editing to VS Code for CSV and other delimited text files. It supports the language modes below, colors fields by column, shows column details on hover, and reports common formatting problems in the Problems panel and the status bar.

## Features

- Handles `.csv`, `.tsv`, `.tab`, `.psv`, `.ssv`, and `.dsv` files. Use **AnyCSV: Enable for Current File** to analyze a delimited file with any other extension.
- Supports comma, tab, semicolon, whitespace, pipe, and dynamic separators. Commas, tabs, semicolons, and pipes inside double-quoted fields are treated as data. Whitespace mode merges consecutive whitespace separators.
- Detects common and configured separators in dynamic mode. Switching an open document to **dynamic csv** prompts for its separator. Use **AnyCSV: Set Delimiter** to enter any single character or string, or select separator text and run **AnyCSV: Set Separator from Selection**.
- Parses escaped double quotes and quoted fields that span lines.
- Colors columns consistently using an 18-color palette supplied by the active VS Code theme, so long rows have more distinct colors and theme changes are respected.
- Hover over a value to see its column number, header name when available, row, and separator.
- Lints malformed quoting and rows with a different number of columns. Click the **CSV** status item at the bottom to review issues.
- Open **AnyCSV: Preview as Table** from the Command Palette or the table icon in the editor title bar for an interactive table in the current editor group, with 100 rows per page, global search, and a filter under every column heading, including the first column. Search and column filters cover all rows. The preview refreshes when the source file or AnyCSV settings change.

Choose a mode from VS Code's language selector in the bottom-right corner:

| Language mode | Separator | File extensions |
| --- | --- | --- |
| `csv` | Auto-detected (comma fallback) | `.csv` |
| `tsv` | Tab | `.tsv`, `.tab` |
| `csv (semicolon)` | Semicolon | Select manually |
| `csv (whitespace)` | Whitespace runs | Select manually |
| `csv (pipe)` | Pipe | `.psv` |
| `dynamic csv` | Auto-detected or custom | `.ssv`, `.dsv` |

With autodetection enabled, AnyCSV recognizes delimited content in **Plain Text** and `.txt` files. Set `anycsv.autoDetect` to `false` to disable content detection, or adjust `anycsv.autoDetectSampleRows` (default `20`) to change how many logical records it inspects. Explicit language modes and custom delimiter settings continue to work when autodetection is off.

You can assign an extension to a mode in VS Code settings. Use the lowercase language IDs shown here:

```json
"files.associations": {
  "*.dat": "csv (pipe)",
  "*.csv": "csv (semicolon)"
}
```

## Commands

- **AnyCSV: Enable for Current File**
- **AnyCSV: Set Delimiter**
- **AnyCSV: Set Separator from Selection**
- **AnyCSV: Auto Detect Delimiter**
- **AnyCSV: Show Lint**
- **AnyCSV: Preview as Table**

## Settings

- `anycsv.delimiter`: `auto` by default. Set a separator such as `;` or `\t`; a configured value overrides the selected language mode.
- `anycsv.autoDetect`: detect content in CSV and Plain Text files, default `true`.
- `anycsv.autoDetectSampleRows`: logical records to inspect during detection, default `20` (range `1`–`200`).
- `anycsv.autoDetectSeparators`: extra separator strings to include in autodetection, for example `["::", "^"]`.
- `anycsv.quoteCharacter`: quote character, default `"`.
- `anycsv.headerRow`: one-based header row, default `1`; set `0` if there is no header.
- `anycsv.ignoreEmptyLines`: skip blank lines in column-count linting, default `true`.

Example setting for separators such as `::` and `^`:

```json
"anycsv.autoDetectSeparators": ["::", "^"]
```
