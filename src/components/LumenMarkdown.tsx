"use client";

import { Fragment, type ReactNode } from "react";
import { CopyTableButton } from "@/components/CopyTableButton";
import { displayCell, isNumeric } from "@/lib/tableExport";

// A small, dependency-free Markdown renderer for Lumen's chat replies, so the
// answer reads like a chat (headings, bold, lists, links) instead of raw text —
// and, crucially, GitHub-style tables render as real tables that copy straight
// into Excel. Deliberately a pragmatic subset (no nested lists / inline HTML);
// anything it doesn't recognise falls through as plain paragraph text.

const INLINE = /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+?\*\*|__[^_]+?__)|(\*[^*\n]+?\*)/g;

function renderInline(text: string, key: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const t = m[0];
    if (m[1]) {
      nodes.push(
        <code key={`${key}-${k}`} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em] text-slate-800">
          {t.slice(1, -1)}
        </code>
      );
    } else if (m[2]) {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(t);
      if (mm)
        nodes.push(
          <a key={`${key}-${k}`} href={mm[2]} target="_blank" rel="noreferrer" className="font-medium text-brand-600 underline underline-offset-2">
            {mm[1]}
          </a>
        );
    } else if (m[3]) {
      nodes.push(
        <strong key={`${key}-${k}`} className="font-semibold text-slate-900">
          {t.slice(2, -2)}
        </strong>
      );
    } else if (m[4]) {
      nodes.push(<em key={`${key}-${k}`}>{t.slice(1, -1)}</em>);
    }
    last = m.index + t.length;
    k++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

const isSeparator = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

function MarkdownTable({ header, sep, body, tk }: { header: string; sep: string; body: string[]; tk: string }) {
  const columns = splitRow(header);
  const align = splitRow(sep).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
  const cells = body.map((line) => splitRow(line));
  // Right-align columns whose body is numeric even without an explicit marker.
  const numericCol = columns.map((_, i) => cells.length > 0 && cells.every((r) => r[i] === undefined || r[i] === "" || isNumeric(r[i])));
  const alignOf = (i: number) => align[i] || (numericCol[i] ? "right" : "left");
  const rowsForCopy = cells.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? ""])));

  return (
    <div className="my-1.5">
      <div className="overflow-x-auto rounded-lg ring-1 ring-slate-200">
        <table className="min-w-full border-collapse text-left text-[13px]">
          <thead className="bg-slate-100 text-slate-600">
            <tr>
              {columns.map((c, i) => (
                <th key={i} className="whitespace-nowrap border-b border-slate-200 px-3 py-2 font-semibold" style={{ textAlign: alignOf(i) as "left" | "right" | "center" }}>
                  {renderInline(c, `${tk}-h${i}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cells.map((row, ri) => (
              <tr key={ri} className="odd:bg-white even:bg-slate-50">
                {columns.map((_, ci) => (
                  <td
                    key={ci}
                    className={`border-b border-slate-100 px-3 py-1.5 ${numericCol[ci] ? "tabular-nums text-slate-800" : "text-slate-700"}`}
                    style={{ textAlign: alignOf(ci) as "left" | "right" | "center" }}
                  >
                    {numericCol[ci] ? displayCell(row[ci]) : renderInline(row[ci] ?? "", `${tk}-${ri}-${ci}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-1.5">
        <CopyTableButton columns={columns} rows={rowsForCopy} />
      </div>
    </div>
  );
}

export function LumenMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line → skip (paragraph separator).
    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code block.
    if (/^\s*```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      out.push(
        <pre key={key++} className="my-1.5 overflow-x-auto rounded-lg bg-slate-900 px-3 py-2 text-[12px] leading-relaxed text-slate-100">
          <code>{buf.join("\n")}</code>
        </pre>
      );
      continue;
    }

    // GFM table (header row + separator row).
    if (line.includes("|") && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const header = line;
      const sep = lines[i + 1];
      i += 2;
      const body: string[] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) body.push(lines[i++]);
      out.push(<MarkdownTable key={key++} header={header} sep={sep} body={body} tk={`t${key}`} />);
      continue;
    }

    // Heading.
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const size = level <= 1 ? "text-base" : level === 2 ? "text-[15px]" : "text-sm";
      out.push(
        <p key={key++} className={`mb-1 mt-1.5 font-semibold text-slate-900 ${size}`}>
          {renderInline(h[2], `h${key}`)}
        </p>
      );
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push(<hr key={key++} className="my-2 border-slate-200" />);
      i++;
      continue;
    }

    // Blockquote.
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(
        <blockquote key={key++} className="my-1.5 border-l-2 border-slate-300 pl-3 text-slate-600">
          {renderInline(buf.join(" "), `bq${key}`)}
        </blockquote>
      );
      continue;
    }

    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, ""));
      out.push(
        <ul key={key++} className="my-1 list-disc space-y-0.5 pl-5">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, `ul${key}-${idx}`)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ""));
      out.push(
        <ol key={key++} className="my-1 list-decimal space-y-0.5 pl-5">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, `ol${key}-${idx}`)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Paragraph — gather consecutive plain lines.
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*([-*_])\1{2,}\s*$/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isSeparator(lines[i + 1]))
    ) {
      buf.push(lines[i++]);
    }
    out.push(
      <p key={key++} className="whitespace-pre-wrap leading-relaxed">
        {renderInline(buf.join("\n"), `p${key}`)}
      </p>
    );
  }

  return <div className="space-y-0.5 text-sm text-slate-800">{out.map((n, idx) => <Fragment key={idx}>{n}</Fragment>)}</div>;
}
