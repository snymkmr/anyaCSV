# Changelog

## 0.2.5

- Keep initial column-color timing diagnostics anonymous by logging elapsed time without the file name.

## 0.2.4

- Stream large table previews from disk, avoiding VS Code's 50 MB text document synchronization limit. Partial previews are limited to 10,000 rows and disable Excel export.
- Lint large delimited files directly from Explorer and report quoting and column-count issues with line locations.
- Keep the last successful table visible when refresh cannot recognize the source, and offer a retry that re-detects the delimiter.
- Apply editor column colors as soon as a CSV becomes visible and recompute them only for visible ranges while scrolling.

## 0.2.1

- Add a Privacy section linking to the project privacy policy.

## 0.2.0

- Rename commands and settings to use the Anya namespace. Update any saved command references and setting keys to the new IDs.
