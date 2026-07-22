"use client";

import { useState } from "react";
import { Mic } from "lucide-react";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import { inactivityReason } from "@/lib/customer-activity";
import type { Restaurant } from "@/lib/types";
import type { InsightContact } from "@/app/api/powerbi/customer-insights/route";

const BRAND = "#739630";

// The fixed list customer service uses to mark an account inactive. Order matches
// how the reps read them out.
const INACTIVITY_REASONS = [
  "No issues",
  "Competition",
  "Make in house",
  "Out of menu / new chef",
  "Payment issues",
  "Quality issues",
  "Gone to distributor",
  "On and off",
  "Refurbishment",
  "To reapproach?",
  "Dry pasta",
  "Didn't work out",
  "Administration (shut)",
  "New account opened",
];
// Reasons that also require closing the account in the reps' records — the
// business is gone (shut) or re-created under a new account / card file.
const CLOSE_ACCOUNT_REASONS = new Set(["Administration (shut)", "New account opened"]);

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
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
}: {
  r: Restaurant;
  phone?: string;
  email?: string;
  author: string;
  contacts?: InsightContact[];
  /** Accepted for call-site compatibility; the samples button is always LTP green. */
  accent?: string;
}) {
  const [note, setNote] = useState("");
  const to = process.env.NEXT_PUBLIC_CUSTOMER_SERVICE_EMAIL || "ltp.orders@latuapasta.com";
  const trimmed = note.trim();
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const by = author.trim() || "Sales";
  const speech = useSpeechRecognition({ onFinal: (t) => setNote((p) => (p ? `${p} ${t}` : t)) });

  // Account snapshot shared by every template, so customer service can find the
  // account. Deliberately just the name + code — account manager, delivery
  // address and last-order date were dropped from these emails.
  const accountBlock = [
    `Account: ${r.name} (${r.postcode})`,
    `Account code: ${r.customerAccountCode || "—"}`,
  ];

  // Place-an-order email: the rep puts what the customer wants (products +
  // quantities) in the box; customer service already holds the account/contact/
  // delivery details, so the email carries only the order + which account.
  const orderSubject = `New order: ${r.name} (${r.postcode})`;
  const orderBody = [
    `Please process a new order for ${r.name}:`,
    "",
    "Order (products & quantities):",
    trimmed,
    "",
    ...accountBlock,
    "",
    `Placed by: ${by} on ${today}`,
  ].join("\n");

  const sampleSubject = `Sample request: ${r.name} (${r.postcode})`;
  const sampleBody = [
    `Please arrange product samples for ${r.name}:`,
    "",
    "Samples requested:",
    trimmed,
    "",
    `Account: ${r.name} (${r.postcode})`,
    `Account code: ${r.customerAccountCode || "—"}`,
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

  // Mark-inactive email: the rep picks the reason from the fixed list customer
  // service uses. Reasons that mean the account is finished (shut down, or
  // re-opened under a new account/card file) also ask customer service to set the
  // sales rep to "Closed" so it drops out of the rep's records.
  const rep = r.customerAccountManager?.trim() || by;
  // The reason already on record (synced from Power BI), if any — used to
  // highlight the matching chip so it's clear what's currently set.
  const recorded = inactivityReason(r);
  const recordedNorm = recorded?.trim().toLowerCase() ?? null;
  function inactiveMailtoFor(reason: string): string {
    const closeNote = CLOSE_ACCOUNT_REASONS.has(reason)
      ? ["", `Please also change the sales rep on this account to "Closed" so it no longer appears in the rep's records.`]
      : [];
    const body = [
      `Please mark ${r.name} (${r.postcode}) as INACTIVE.`,
      "",
      `Status: Inactive`,
      `Reason: ${reason}`,
      `Sales rep: ${rep}`,
      "",
      `Account: ${r.name} (${r.postcode})`,
      `Account code: ${r.customerAccountCode || "—"}`,
      ...(trimmed ? ["", `Additional info: ${trimmed}`] : []),
      ...closeNote,
      "",
      `Reported by: ${by} on ${today}`,
    ].join("\n");
    return `mailto:${to}?subject=${encodeURIComponent(`Inactive account: ${r.name} (${r.postcode}) — ${reason}`)}&body=${encodeURIComponent(body)}`;
  }

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
          placeholder="An order (products & quantities), samples needed, a contact-detail change, or why they've gone quiet — type or dictate…"
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

      <div className="mt-2 flex flex-wrap gap-2">
        <a
          href={mailto(orderSubject, orderBody)}
          aria-disabled={!trimmed}
          className={btn("bg-blue-600 text-white")}
        >
          Place order ↗
        </a>
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

      <div className="mt-3 border-t border-slate-200 pt-3">
        <p className="mb-1 text-xs font-semibold text-slate-700">
          Set status to inactive — pick a reason (emails customer service):
        </p>
        {recorded && (
          <p className="mb-2 text-[11px] text-slate-500">
            On record: <span className="font-medium text-slate-700">{recorded}</span>
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {INACTIVITY_REASONS.map((reason) => {
            const isRecorded = recordedNorm !== null && recordedNorm === reason.toLowerCase();
            return (
              <a
                key={reason}
                href={inactiveMailtoFor(reason)}
                // Every reason chip looks the same; only the reason already ON
                // RECORD is highlighted (dark), so it's clear what's currently set.
                className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition active:scale-95 ${
                  isRecorded
                    ? "bg-slate-900 text-white ring-slate-900 hover:bg-black"
                    : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-100"
                }`}
                title={
                  (isRecorded ? "Currently recorded reason. " : "") +
                  (CLOSE_ACCOUNT_REASONS.has(reason)
                    ? "Emails customer service to set this account inactive AND set the sales rep to Closed"
                    : "Emails customer service to set this account inactive with this reason")
                }
              >
                {reason}
              </a>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11px] text-slate-400">
          “Administration (shut)” and “New account opened” also ask customer service to set the sales rep to Closed. Add anything extra in the box above and it&apos;s included.
        </p>
      </div>
    </div>
  );
}
