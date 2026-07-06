"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyTable } from "@/lib/tableExport";

// Copy a column/row set to the clipboard as a real table (pastes into Excel /
// Sheets as cells). Shared by the visualization table, chart footers, and the
// Markdown tables Lumen writes in chat.
export function CopyTableButton({
  columns,
  rows,
  label = "Copy table",
  className = "",
}: {
  columns: string[];
  rows: Record<string, unknown>[];
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function onClick() {
    const ok = await copyTable(columns, rows);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
        copied
          ? "bg-green-100 text-green-700"
          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
      } ${className}`}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? "Copied" : label}
    </button>
  );
}
