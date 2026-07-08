"use client";

import { useState } from "react";
import { Mic } from "lucide-react";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import type { Restaurant } from "@/lib/types";
import type { InsightContact } from "@/app/api/powerbi/customer-insights/route";

const BRAND = "#739630";

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// Templated customer-service emails for a customer — shared by the phone
// customer sheet and the laptop profile. Each button opens the rep's own mail
// app (via mailto) pre-filled and addressed to customer service; nothing is
// auto-sent. Inactive accounts get an extra "log the reason" action.
export function CustomerServiceEmails({
  r,
  phone,
  email,
  author,
  contacts,
  accent = BRAND,
  inactive = false,
}: {
  r: Restaurant;
  phone?: string;
  email?: string;
  author: string;
  contacts?: InsightContact[];
  accent?: string;
  inactive?: boolean;
}) {
  const [note, setNote] = useState("");
  const [showReason, setShowReason] = useState(false);
  const [reason, setReason] = useState("");
  const to = process.env.NEXT_PUBLIC_CUSTOMER_SERVICE_EMAIL || "info@latuapasta.com";
  const trimmed = note.trim();
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const by = author.trim() || "Sales";

  const sampleSubject = `Sample request: ${r.name} (${r.postcode})`;
  const sampleBody = [
    `Please arrange product samples for ${r.name}:`,
    "",
    "Samples requested:",
    trimmed,
    "",
    `Deliver to: ${[r.address, r.postcode].filter(Boolean).join(", ")}`,
    `Contact: ${r.customerContactName || "—"}${phone ? ` · ${phone}` : ""}`,
    `Account code: ${r.customerAccountCode || "—"}`,
    "",
    `Requested by: ${by} on ${today}`,
  ].join("\n");
  const sampleMailto = `mailto:${to}?subject=${encodeURIComponent(sampleSubject)}&body=${encodeURIComponent(sampleBody)}`;

  // Prefer the live Power BI contacts over the single cached field (which can
  // fall back to Google Places data) — customer service needs the real record.
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
    "Current record:",
    `- Account manager: ${r.customerAccountManager || "—"}`,
    ...contactLines,
    "",
    "Requested change:",
    trimmed,
    "",
    `Reported by: ${by} on ${today}`,
  ].join("\n");
  const changeMailto = `mailto:${to}?subject=${encodeURIComponent(changeSubject)}&body=${encodeURIComponent(changeBody)}`;

  // Inactivity reason (only offered for inactive accounts).
  const reasonTrimmed = reason.trim();
  const inactiveSubject = `Inactive account: ${r.name} (${r.postcode})`;
  const inactiveBody = [
    `Flagging ${r.name} (${r.postcode}) as an inactive account — no recent orders.`,
    "",
    "Reason for inactivity:",
    reasonTrimmed,
    "",
    `Account code: ${r.customerAccountCode || "—"}`,
    `Account manager: ${r.customerAccountManager || "—"}`,
    "",
    `Reported by: ${by} on ${today}`,
  ].join("\n");
  const inactiveMailto = `mailto:${to}?subject=${encodeURIComponent(inactiveSubject)}&body=${encodeURIComponent(inactiveBody)}`;

  const speech = useSpeechRecognition({ onFinal: (t) => setReason((p) => (p ? `${p} ${t}` : t)) });

  return (
    <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
      <p className="mb-2 text-xs font-semibold text-slate-700">Need something from customer service?</p>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What's needed? e.g. 2kg truffle girasoli samples — or what's wrong, e.g. phone number should be 020 7946 0958"
        rows={2}
        className="w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-slate-400"
      />
      <div className="mt-2 flex gap-2">
        <a
          href={trimmed ? sampleMailto : undefined}
          aria-disabled={!trimmed}
          style={trimmed ? { backgroundColor: accent } : undefined}
          className={`flex-1 rounded-lg py-2.5 text-center text-xs font-semibold transition active:scale-95 ${
            trimmed ? "text-white" : "pointer-events-none bg-slate-200 text-slate-400"
          }`}
        >
          Request samples ↗
        </a>
        <a
          href={trimmed ? changeMailto : undefined}
          aria-disabled={!trimmed}
          className={`flex-1 rounded-lg py-2.5 text-center text-xs font-semibold transition active:scale-95 ${
            trimmed ? "bg-amber-600 text-white" : "pointer-events-none bg-slate-200 text-slate-400"
          }`}
        >
          Report change ↗
        </a>
      </div>

      {inactive && (
        <div className="mt-2">
          {!showReason ? (
            <button
              onClick={() => setShowReason(true)}
              className="w-full rounded-lg bg-slate-900 py-2.5 text-center text-xs font-semibold text-white transition active:scale-95 hover:bg-black"
            >
              Log reason this account is inactive ↗
            </button>
          ) : (
            <div className="rounded-lg bg-white p-2.5 ring-1 ring-slate-200">
              <p className="mb-1.5 text-xs font-medium text-slate-600">
                Why has this account gone quiet? (e.g. changed supplier after a price rise)
              </p>
              <div className="relative">
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Type or dictate the reason…"
                  rows={3}
                  className="w-full resize-none rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 pr-10 text-sm outline-none focus:border-slate-400"
                />
                {speech.supported && (
                  <button
                    onClick={speech.toggle}
                    aria-label={speech.listening ? "Stop dictation" : "Dictate the reason"}
                    className={`absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full transition ${
                      speech.listening ? "animate-pulse bg-red-500 text-white" : "bg-slate-200 text-slate-600 hover:bg-slate-300"
                    }`}
                  >
                    <Mic size={15} />
                  </button>
                )}
              </div>
              {speech.listening && <p className="mt-1 text-[11px] text-red-500">Listening… speak the reason.</p>}
              <a
                href={reasonTrimmed ? inactiveMailto : undefined}
                aria-disabled={!reasonTrimmed}
                className={`mt-2 block w-full rounded-lg py-2.5 text-center text-xs font-semibold transition active:scale-95 ${
                  reasonTrimmed ? "bg-slate-900 text-white hover:bg-black" : "pointer-events-none bg-slate-200 text-slate-400"
                }`}
              >
                Send reason to customer service ↗
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
