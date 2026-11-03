# AnyaCSV

AnyaCSV brings delimiter-aware editing to VS Code for CSV and other delimited text files. It supports the language modes below, colors fields by column, shows column details on hover, and reports common formatting problems in the Problems panel and the status bar.

## Features

- Handles `.csv`, `.tsv`, `.tab`, `.psv`, `.ssv`, and `.dsv` files. Use **AnyaCSV: Enable for Current File** to analyze a delimited file with any other extension.
- Supports comma, tab, semicolon, whitespace, pipe, and dynamic separators. Commas, tabs, semicolons, and pipes inside double-quoted fields are treated as data. Whitespace mode merges consecutive whitespace separators.
- Detects common and configured separators in dynamic mode. Switching an open document to **dynamic csv** prompts for its separator. Use **AnyaCSV: Set Delimiter** to enter any single character or string, or select separator text and run **AnyaCSV: Set Separator from Selection**.
- Parses escaped double quotes and quoted fields that span lines.
- Colors the five fixed-delimiter modes with native TextMate grammars and cycles through ten theme-aware column colors. Dynamic CSV uses range semantic tokens and handles multiline quoted fields.
- Recolors with the active VS Code theme. Fixed-mode grammar coloring is viewport-first and incremental, including when you scroll.
- Hover over a value to see its column number, header name when available, row, and separator.
- Lints malformed quoting and rows with a different number of columns. Click the **CSV** status item at the bottom to review issues.
- Open **AnyaCSV: Preview as Table** from the Command Palette or editor title bar, or right-click a supported delimited file and choose **Preview as Table**. To preview a `.txt` file, first select an AnyaCSV language mode in VS Code's language selector. The preview opens a side-by-side table with global and per-column filters, adjustable page size, row numbers, and pop-out. Use the exact-filter icon beside **Export** to switch between substring and exact-value matching. The green **Export** button saves all rows matching the current filters as a real Excel workbook (`.xlsx`); it exports the full filtered result, not only the visible page. Values are stored as text so Excel keeps identifiers, dates, and formula-like strings as shown, and the source file is unchanged. The preview refreshes when the source file or AnyaCSV settings change.

  Refresh reuses the delimiter that was working for the preview session. If the source no longer looks delimited, AnyaCSV keeps the last good table visible and shows a warning with a **Retry / re-detect delimiter** action.

  Files larger than 50 MB are streamed from disk for preview and lint, so they do not need to be opened as editor documents. Large-file previews load at most 10,000 rows. Filtering applies to the loaded rows, and Excel export is disabled when the preview is partial. Large-file lint reports issue locations in a message instead of the Problems panel. Save the file before refreshing the preview.

Choose a mode from VS Code's language selector in the bottom-right corner:

| Language mode | Separator | File extensions |
| --- | --- | --- |
| `csv` | Auto-detected (comma fallback) | `.csv` |
| `tsv` | Tab | `.tsv`, `.tab` |
| `csv (semicolon)` | Semicolon | Select manually |
| `csv (whitespace)` | Whitespace runs | Select manually |
| `csv (pipe)` | Pipe | `.psv` |
| `dynamic csv` | Auto-detected or custom | `.ssv`, `.dsv` |

With autodetection enabled, AnyaCSV recognizes delimited content in **Plain Text** documents. A `.txt` file is only treated as delimited when you select an AnyaCSV language mode in the language selector; its extension alone will not trigger CSV detection. You can also use **AnyaCSV: Enable for Current File** as an explicit per-file override. Set `anyacsv.autoDetect` to `false` to disable content detection, or adjust `anyacsv.autoDetectSampleRows` (default `20`) to change how many logical records it inspects. Explicit language modes and custom delimiter settings continue to work when autodetection is off.

You can assign an extension to a mode in VS Code settings. Use the lowercase language IDs shown here:

```json
"files.associations": {
  "*.dat": "csv (pipe)",
  "*.csv": "csv (semicolon)"
}
```

The fixed-mode grammars color a multiline quoted field's continuation lines as new fields. Dynamic CSV handles multiline quoted fields correctly. Other extensions that register grammars for the same language IDs can override AnyaCSV's coloring, so disable one extension's coloring if both are installed.

## Commands

- **AnyaCSV: Enable for Current File**
- **AnyaCSV: Set Delimiter**
- **AnyaCSV: Set Separator from Selection**
- **AnyaCSV: Auto Detect Delimiter**
- **AnyaCSV: Show Lint**
- **AnyaCSV: Preview as Table**

## Settings

- `anyacsv.delimiter`: `auto` by default. Set a separator such as `;` or `\t`; a configured value overrides the selected language mode.
- `anyacsv.autoDetect`: detect content in CSV and Plain Text documents, default `true`. `.txt` files require an AnyaCSV language mode or explicit per-file activation.
- `anyacsv.autoDetectSampleRows`: logical records to inspect during detection, default `20` (range `1`–`200`).
- `anyacsv.autoDetectSeparators`: extra separator strings to include in autodetection, for example `["::", "^"]`.
- `anyacsv.quoteCharacter`: quote character, default `"`.
- `anyacsv.headerRow`: one-based header row, default `1`; set `0` if there is no header.
- `anyacsv.ignoreEmptyLines`: skip blank lines in column-count linting, default `true`.

Example setting for separators such as `::` and `^`:

```json
"anyacsv.autoDetectSeparators": ["::", "^"]
```

## Privacy

See the [Privacy Policy](https://sanyam.dev/privacy) for privacy information about my projects.
