// Shared table helpers for Lumen — on-screen number formatting plus clipboard
// export that pastes cleanly into Excel / Google Sheets.
//
// Two different number renderings on purpose:
//  - displayCell(): grouped for humans on screen (1,284 / 635,606.15).
//  - exportCell():  RAW canonical numbers for the clipboard (no thousands
//    separators), so a spreadsheet always parses them as numbers regardless of
//    the user's locale — a "1,284" string can import as text in some locales.

export function isNumeric(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "boolean") return false;
  return !Number.isNaN(Number(value));
}

export function displayCell(value: unknown): string {
  if (isNumeric(value)) {
    const n = Number(value);
    return Number.isInteger(n)
      ? n.toLocaleString("en-GB")
      : n.toLocaleString("en-GB", { maximumFractionDigits: 2 });
  }
  return String(value ?? "");
}

// Canonical, un-grouped text for the clipboard.
export function exportCell(value: unknown): string {
  if (isNumeric(value)) return String(Number(value));
  return String(value ?? "");
}

// Tab-separated plain-text — pastes as columns in a spreadsheet even without
// HTML clipboard support, and (unlike commas) never collides with a decimal
// point inside a numeric cell.
export function toTsv(columns: string[], rows: Record<string, unknown>[]): string {
  const esc = (value: unknown) => exportCell(value).replace(/\t/g, " ").replace(/\n/g, " ");
  return [
    columns.map(esc).join("\t"),
    ...rows.map((row) => columns.map((col) => esc(row[col])).join("\t")),
  ].join("\n");
}

// Real <table> markup for the clipboard's text/html slot — this is what lets a
// paste into Excel/Sheets/Docs land as actual cells instead of one delimited blob.
export function toHtmlTable(columns: string[], rows: Record<string, unknown>[]): string {
  const esc = (value: unknown) =>
    String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const head = `<tr>${columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>`;
  const body = rows
    .map((row) => `<tr>${columns.map((col) => `<td>${esc(exportCell(row[col]))}</td>`).join("")}</tr>`)
    .join("");
  return `<table>${head}${body}</table>`;
}

// Write both representations so a paste into a spreadsheet lands as real cells
// (text/html) while plain-text targets still get clean TSV.
export async function copyTable(columns: string[], rows: Record<string, unknown>[]): Promise<boolean> {
  const tsv = toTsv(columns, rows);
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      const html = toHtmlTable(columns, rows);
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([tsv], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
    } else {
      await navigator.clipboard.writeText(tsv);
    }
    return true;
  } catch {
    return false;
  }
}
