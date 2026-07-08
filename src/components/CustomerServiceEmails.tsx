"use client";

import { useState } from "react";
import { Mic } from "lucide-react";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import { lastOrderMonth } from "@/lib/customer-activity";
import type { Restaurant } from "@/lib/types";
import type { InsightContact } from "@/app/api/powerbi/customer-insights/route";

const BRAND = "#739630";

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// "Last order: Mar 2026 (4 months ago)" from the synced sales history.
function lastOrderLine(r: Restaurant): string {
  const m = lastOrderMonth(r);
  if (!m) return "Last order: none on record in the synced window";
  const [y, mo] = m.split("-").map(Number);
  const label = new Date(y, mo - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
  const now = new Date();
  const monthsAgo = (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - mo);
  const ago = monthsAgo <= 0 ? "this month" : `${monthsAgo} month${monthsAgo === 1 ? "" : "s"} ago`;
  return `Last order: ${label} (${ago})`;
}

// Templated customer-service emails for a customer — shared by the phone
// customer sheet and the laptop profile. One field (with voice dictation) feeds
// all the actions; each button opens the rep's own mail app (mailto) pre-filled
// and addressed to customer service. Nothing is auto-sent.
export function CustomerServiceEmails({
  r,
  phone,
  email,
  author,
  contacts,
  inactive = false,
}: {
  r: Restaurant;
  phone?: string;
  email?: string;
  author: string;
  contacts?: InsightContact[];
  /** Accepted for call-site compatibility; the samples button is always LTP green. */
  accent?: string;
  inactive?: boolean;
}) {
  const [note, setNote] = useState("");
  const to = process.env.NEXT_PUBLIC_CUSTOMER_SERVICE_EMAIL || "info@latuapasta.com";
  const trimmed = note.trim();
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const by = author.trim() || "Sales";
  const speech = useSpeechRecognition({ onFinal: (t) => setNote((p) => (p ? `${p} ${t}` : t)) });

  // Account snapshot shared by every template, so customer service always has
  // the context (who, code, manager, and how long since they last ordered).
  const accountBlock = [
    `Account: ${r.name} (${r.postcode})`,
    `Account code: ${r.customerAccountCode || "—"}`,
    `Account manager: ${r.customerAccountManager || "—"}`,
    lastOrderLine(r),
  ];

  const sampleSubject = `Sample request: ${r.name} (${r.postcode})`;
  const sampleBody = [
    `Please arrange product samples for ${r.name}:`,
    "",
    "Samples requested:",
    trimmed,
    "",
    ...accountBlock,
    `Deliver to: ${[r.address, r.postcode].filter(Boolean).join(", ")}`,
    `Contact: ${r.customerContactName || "—"}${phone ? ` · ${phone}` : ""}`,
    "",
    `Requested by: ${by} on ${today}`,
  ].join("\n");

  const contactLines =
    contacts && contacts.length > 0
      ? contacts.flatMap((c) => {
          const lines = [`- ${c.name ? titleCase(c.name) : "Contact"}${c.role ? ` (${titleCase(c.role)})` : ""}`];
          const phones = [c.phone1, c.phone2].filter(Boolean).join(", ");
          if (phones) lines.push(`  Phone: ${phones}`);
          if (c.email) lines.push(`  Email: ${c.email.toLowerCase()}`);
          if (c.flags.length > 0) lines.push(`  Roles: ${c.flags.join(", ")}`);
          return lines;
        })
      : [
          `- Contact name: ${r.customerContactName || "—"}`,
          `- Phone: ${phone || "—"}`,
          `- Email: ${email || "—"}`,
        ];

  const changeSubject = `Contact update needed: ${r.name} (${r.postcode})`;
  const changeBody = [
    `Please update the following contact details in Power BI for ${r.name} (${r.postcode}):`,
    "",
    ...accountBlock,
    "",
    "Current contacts on record:",
    ...contactLines,
    "",
    "Requested change:",
    trimmed,
    "",
    `Reported by: ${by} on ${today}`,
  ].join("\n");

  const inactiveSubject = `Inactive account: ${r.name} (${r.postcode})`;
  const inactiveBody = [
    `Flagging ${r.name} (${r.postcode}) as an inactive account — no recent orders.`,
    "",
    ...accountBlock,
    "",
    "Reason for inactivity:",
    trimmed,
    "",
    `Reported by: ${by} on ${today}`,
  ].join("\n");

  const mailto = (subject: string, body: string) =>
    trimmed ? `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` : undefined;

  const btn = (active: string) =>
    `flex-1 rounded-lg py-2.5 text-center text-xs font-semibold transition active:scale-95 ${
      trimmed ? active : "pointer-events-none bg-slate-200 text-slate-400"
    }`;

  return (
    <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
      <p className="mb-2 text-xs font-semibold text-slate-700">Need something from customer service?</p>
      <div className="relative">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What's needed (samples), what's wrong (contact details), or why they've gone quiet — type or dictate…"
          rows={2}
          className="w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 pr-10 text-sm outline-none focus:border-slate-400"
        />
        {speech.supported && (
          <button
            onClick={speech.toggle}
            aria-label={speech.listening ? "Stop dictation" : "Dictate"}
            className={`absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full transition ${
              speech.listening ? "animate-pulse bg-red-500 text-white" : "bg-slate-200 text-slate-600 hover:bg-slate-300"
            }`}
          >
            <Mic size={15} />
          </button>
        )}
      </div>
      {speech.listening && <p className="mt-1 text-[11px] text-red-500">Listening… speak now.</p>}

      <div className="mt-2 flex gap-2">
        <a
          href={mailto(sampleSubject, sampleBody)}
          aria-disabled={!trimmed}
          style={trimmed ? { backgroundColor: BRAND } : undefined}
          className={btn("text-white")}
        >
          Request samples ↗
        </a>
        <a href={mailto(changeSubject, changeBody)} aria-disabled={!trimmed} className={btn("bg-amber-600 text-white")}>
          Report change ↗
        </a>
      </div>

      {inactive && (
        <a
          href={mailto(inactiveSubject, inactiveBody)}
          aria-disabled={!trimmed}
          className={`mt-2 block w-full rounded-lg py-2.5 text-center text-xs font-semibold transition active:scale-95 ${
            trimmed ? "bg-slate-900 text-white hover:bg-black" : "pointer-events-none bg-slate-200 text-slate-400"
          }`}
        >
          Log reason this account is inactive ↗
        </a>
      )}
    </div>
  );
}
