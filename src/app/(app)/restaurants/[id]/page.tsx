"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { EditableRep, repName } from "@/components/RepCell";
import { ChainBadge, InactiveBadge, LeadBadge, OutreachBadge, PriceTag, RecommendBadge } from "@/components/StatusBadge";
import { VisitRhythmCard } from "@/components/visits/VisitRhythmCard";
import { MeetingsCard } from "@/components/visits/MeetingsCard";
import { ScheduleVisitModal } from "@/components/visits/ScheduleVisitModal";
import { RecordMeetingSheet } from "@/components/visits/RecordMeetingSheet";
import { CustomerInsightsCard } from "@/components/CustomerInsightsCard";
import { CustomerServiceEmails } from "@/components/CustomerServiceEmails";
import { PRICE_LABELS } from "@/lib/mock-data";
import { detectChain } from "@/lib/chains";
import { useRestaurants } from "@/lib/store";
import { useRep } from "@/lib/rep";
import { fromDateKey, toDateKey } from "@/lib/visits/dates";
import { INACTIVE_AFTER_MONTHS, customerActivity } from "@/lib/customer-activity";
import { visibleNotes } from "@/lib/activity-visibility";
import { deliveryDaysForPostcode } from "@/data/delivery-days";
import { venueWebsite } from "@/lib/types";
import type { ContactNote, ContactOutcome, Restaurant, ScoreBreakdown } from "@/lib/types";

const OUTCOME_LABELS: Record<ContactOutcome, string> = {
  called: "Called",
  emailed: "Emailed",
  visited: "Visited",
  meeting: "Meeting",
  samples_sent: "Samples sent",
  quote_sent: "Quote sent",
  interested: "Interested",
  not_interested: "Not interested",
  no_answer: "No answer",
  follow_up: "Follow-up",
  other: "Note",
};

const OUTCOME_STYLE: Record<ContactOutcome, string> = {
  called: "bg-slate-100 text-slate-700",
  emailed: "bg-slate-100 text-slate-700",
  visited: "bg-slate-100 text-slate-700",
  meeting: "bg-indigo-100 text-indigo-700",
  samples_sent: "bg-indigo-100 text-indigo-700",
  quote_sent: "bg-indigo-100 text-indigo-700",
  interested: "bg-green-100 text-green-700",
  not_interested: "bg-red-100 text-red-700",
  no_answer: "bg-amber-100 text-amber-700",
  follow_up: "bg-amber-100 text-amber-700",
  other: "bg-slate-100 text-slate-700",
};

const SCORE_ROWS: { key: keyof ScoreBreakdown; label: string; max: number }[] = [
  { key: "cuisineFit", label: "Cuisine fit", max: 50 },
  { key: "priceFit", label: "Price point fit", max: 50 },
];

function barColor(val: number, max: number): string {
  const pct = val / max;
  if (pct >= 0.6) return "bg-green-500";
  if (pct >= 0.35) return "bg-amber-400";
  return "bg-red-500";
}

export default function RestaurantProfile() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { restaurants, updateRestaurant } = useRestaurants();
  const { me } = useRep();
  const r = restaurants.find((x) => x.id === params.id);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);

  if (!r) {
    return (
      <div className="rounded-xl bg-white p-10 text-center text-slate-500 ring-1 ring-slate-200">
        Restaurant not found.{" "}
        <Link href="/leads" className="text-brand-600 hover:underline">
          Back to leads
        </Link>
      </div>
    );
  }

  return (
    <div>
      <Link href="/leads" className="mb-3 inline-block text-sm text-brand-600 hover:underline">
        ← Back to leads
      </Link>
      <PageHeader
        title={r.name}
        subtitle={`${r.cuisineType} · ${r.businessType} · ${r.borough}`}
        action={
          <div className="flex items-center gap-3">
            {detectChain(r.name) && <ChainBadge brand={detectChain(r.name)!} />}
            {r.existingCustomer && (
              <span className="rounded bg-blue-100 px-2 py-1 text-xs font-medium text-blue-700">LTP customer</span>
            )}
            {r.existingCustomer && !customerActivity(r).active && <InactiveBadge />}
            {r.recommended && !r.existingCustomer && <RecommendBadge />}
            {/* Lead score is a prospecting signal — meaningless once they're a
                customer, so customers see their live sales instead (below). */}
            {!r.existingCustomer && (
              <>
                <span className="text-2xl font-bold text-slate-900">{r.leadScore}</span>
                <LeadBadge category={r.leadCategory} />
              </>
            )}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {r.existingCustomer ? (
            <CustomerInsightsCard r={r} />
          ) : (
            <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
              <h2 className="mb-3 text-sm font-semibold text-slate-900">
                Why this lead scored {r.leadScore} — cuisine + price
              </h2>
              <p className="mb-4 text-sm text-slate-600">{r.scoreReason}</p>
              <div className="space-y-3">
                {SCORE_ROWS.map(({ key, label, max }) => {
                  const val = r.scoreBreakdown[key];
                  return (
                    <div key={key} className="flex items-center gap-3">
                      <div className="w-36 shrink-0 text-sm text-slate-600">{label}</div>
                      <div className="h-2 flex-1 rounded-full bg-slate-100">
                        <div className={`h-2 rounded-full ${barColor(val, max)}`} style={{ width: `${(val / max) * 100}%` }} />
                      </div>
                      <div className="w-14 shrink-0 text-right text-sm font-medium text-slate-700">{val}/{max}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">Source evidence</h2>
            <p className="text-sm text-slate-600">{r.source}</p>
            {r.openingEvidence && <p className="mt-1 text-sm text-slate-500">{r.openingEvidence}</p>}
          </div>

          <MeetingsCard venueId={r.id} />

          {/* key by id: a fresh log form per venue, so outcome / follow-up state
              never carries across when navigating between profiles. */}
          <ContactLog key={r.id} r={r} onChange={(log) => updateRestaurant(r.id, { contactLog: log })} onRecord={() => setRecordOpen(true)} />
        </div>

        <div className="space-y-6">
          {r.existingCustomer && <VisitRhythmCard r={r} />}
          {r.existingCustomer && (
            <CustomerActivityControl
              r={r}
              onChange={(customerActive) => updateRestaurant(r.id, { customerActive })}
            />
          )}
          <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">Contact &amp; status</h2>
            <dl className="space-y-2 text-sm">
              {r.existingCustomer && (
                <Row label="Sales rep" node={repName(r) ? repName(r) : <EditableRep r={r} />} />
              )}
              <Row label="Address" value={`${r.address}, ${r.postcode}`} />
              {deliveryDaysForPostcode(r.postcode) && <Row label="Delivery days" value={deliveryDaysForPostcode(r.postcode)!} />}
              <Row label="Email" node={r.email ? <a className="text-brand-600 hover:underline" href={`mailto:${r.email}`}>{r.email}</a> : "—"} />
              <Row label="Phone" node={r.phone ? <a className="text-brand-600 hover:underline" href={`tel:${r.phone}`}>{r.phone}</a> : "—"} />
              <Row label="Website" node={(() => { const site = venueWebsite(r); return site ? <a className="text-brand-600 hover:underline" href={site} target="_blank" rel="noreferrer">Visit site ↗</a> : "—"; })()} />
              <Row label="Price point" value={PRICE_LABELS[r.priceTier]} />
              <Row label="Hygiene rating" value={r.hygieneRating ? `${r.hygieneRating}/5` : "—"} />
              <Row label="Assigned to" value={r.assignedOwner ?? "Unassigned"} />
            </dl>
            <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3">
              <span className="text-sm text-slate-500">Outreach</span>
              <OutreachBadge status={r.outreachStatus} />
            </div>
            <div className="mt-4 flex gap-2">
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${r.name} ${r.postcode}`)}`}
                target="_blank" rel="noreferrer"
                className="flex-1 rounded-lg bg-slate-100 px-3 py-2 text-center text-xs font-medium text-slate-700 hover:bg-slate-200"
              >
                Google Maps ↗
              </a>
              <a
                href={`https://www.google.com/search?q=${encodeURIComponent(`${r.name} ${r.borough} restaurant`)}`}
                target="_blank" rel="noreferrer"
                className="flex-1 rounded-lg bg-slate-100 px-3 py-2 text-center text-xs font-medium text-slate-700 hover:bg-slate-200"
              >
                Search web ↗
              </a>
            </div>
          </div>

          <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <h2 className="mb-3 text-sm font-semibold text-slate-900">Actions</h2>
            <div className="grid grid-cols-2 gap-2">
              <Action
                onClick={() => { updateRestaurant(r.id, { outreachStatus: "draft_ready" }); router.push("/emails"); }}
                className="bg-brand-500 text-white hover:bg-brand-600"
              >
                Generate email draft
              </Action>
              <Action onClick={() => router.push("/emails")} className="bg-slate-100 text-slate-700 hover:bg-slate-200">Email centre</Action>
              <Action onClick={() => setRecordOpen(true)} className="bg-indigo-50 text-indigo-700 hover:bg-indigo-100">Record note</Action>
              <Action onClick={() => setScheduleOpen(true)} className="bg-slate-100 text-slate-700 hover:bg-slate-200">Schedule visit</Action>
            </div>
            {r.nextAction && <p className="mt-3 text-xs text-slate-400">Next action: {r.nextAction}</p>}
          </div>

          {r.existingCustomer && (
            <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
              <h2 className="mb-3 text-sm font-semibold text-slate-900">Customer service</h2>
              <CustomerServiceEmails
                r={r}
                phone={r.customerContactPhone || r.phone}
                email={r.customerContactEmail || r.email}
                author={me?.name ?? ""}
                inactive={!customerActivity(r).active}
              />
            </div>
          )}
        </div>
      </div>

      <ScheduleVisitModal open={scheduleOpen} onClose={() => setScheduleOpen(false)} venue={r} />
      {recordOpen && <RecordMeetingSheet venue={r} onClose={() => setRecordOpen(false)} />}
    </div>
  );
}

function Row({ label, value, node }: { label: string; value?: string; node?: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-800">{node ?? value}</dd>
    </div>
  );
}

function Action({ children, className, onClick }: { children: React.ReactNode; className: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} className={`rounded-lg px-3 py-2 text-sm font-medium transition ${className}`}>
      {children}
    </button>
  );
}

// Per-venue contact log: who tried to sell to this restaurant, when, and what
// happened. Persists through the store (override on FSA venues, inline on added
// records), so the whole team sees the history.
function ContactLog({ r, onChange, onRecord }: { r: Restaurant; onChange: (log: ContactNote[]) => void; onRecord: () => void }) {
  const log = r.contactLog ?? [];
  const { me, reps, seesEverything } = useRep();
  const meRep = me ? reps.find((x) => x.id === me.id) ?? { id: me.id, name: me.name, aliases: [] as string[] } : null;
  // A rep only sees their own notes; admins/devs see everyone's.
  const visibleLog = visibleNotes(log, { rep: meRep, seesEverything });
  const [author, setAuthor] = useState("");
  const [text, setText] = useState("");
  const [date, setDate] = useState(() => toDateKey(new Date()));

  function add() {
    const body = text.trim();
    if (!body) return;
    const note: ContactNote = {
      id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${r.id}-${log.length}-${new Date().toISOString()}`,
      author: author.trim() || "Sales team",
      text: body,
      at: fromDateKey(date).toISOString(),
      repId: me?.id,
    };
    onChange([note, ...log]); // newest first
    setText(""); // keep author for quick repeat logging
  }

  function remove(id: string) {
    onChange(log.filter((n) => n.id !== id));
  }

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Notes &amp; contact log</h2>
        <span className="text-xs text-slate-400">{visibleLog.length} note{visibleLog.length === 1 ? "" : "s"}</span>
      </div>

      <button
        onClick={onRecord}
        className="mb-3 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-500 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-600"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" />
        </svg>
        Record note (meeting or call)
      </button>

      <div className="mb-4 space-y-2 rounded-lg bg-slate-50 p-3 ring-1 ring-slate-100">
        <div className="flex flex-wrap gap-2">
          <input
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="Your name"
            className="w-40 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand-500"
          />
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand-500"
          />
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") add(); }}
          placeholder="What happened when you contacted them? (e.g. spoke to the manager, asked for samples, call back next week)"
          rows={2}
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500"
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-400">⌘/Ctrl + Enter to add</span>
          <button
            onClick={add}
            disabled={!text.trim()}
            className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-40"
          >
            Add note
          </button>
        </div>
      </div>

      {visibleLog.length === 0 ? (
        <p className="text-sm text-slate-400">No contact logged yet. Record calls, emails and visits here so you can see what you’ve tried.</p>
      ) : (
        <ul className="space-y-3">
          {visibleLog.map((n) => (
            <li key={n.id} className="group border-l-2 border-slate-200 pl-3">
              <div className="flex items-center gap-2 text-xs text-slate-500">
                {n.outcome && (
                  <span className={`rounded px-1.5 py-0.5 font-medium ${OUTCOME_STYLE[n.outcome]}`}>{OUTCOME_LABELS[n.outcome]}</span>
                )}
                <span className="font-medium text-slate-700">{n.author}</span>
                <span>·</span>
                <span>{formatWhen(n.at)}</span>
                <button
                  onClick={() => remove(n.id)}
                  className="ml-auto text-slate-300 opacity-0 transition group-hover:opacity-100 hover:text-red-600"
                  title="Delete note"
                >
                  ✕
                </button>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{n.text}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return (
    d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) +
    " · " +
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  );
}

// Shown in the contact log when "Samples sent" is the outcome: pick a date and
// "Account activity" card on a customer's profile: shows whether they count as
// active (ordered recently) and lets a rep override the automatic call.
function CustomerActivityControl({
  r,
  onChange,
}: {
  r: Restaurant;
  onChange: (active: boolean | null) => void;
}) {
  const activity = customerActivity(r);
  const isManual = activity.source === "manual";
  const lastPretty = activity.lastOrderMonth
    ? new Date(activity.lastOrderMonth + "-01T12:00:00").toLocaleDateString("en-GB", { month: "short", year: "numeric" })
    : null;
  const reason =
    activity.source === "manual"
      ? `Manually marked ${activity.active ? "active" : "inactive"}.`
      : activity.source === "unknown"
        ? "No synced order history yet — shown in the list by default."
        : activity.active
          ? `Last order ${lastPretty}.`
          : lastPretty
            ? `No orders since ${lastPretty} — hidden from the customers list by default.`
            : `No orders in the last ${INACTIVE_AFTER_MONTHS} months — hidden from the customers list by default.`;

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Account activity</h2>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
            activity.active ? "bg-green-100 text-green-700" : "bg-slate-200 text-slate-600"
          }`}
        >
          {activity.active ? "Active" : "Inactive"}
        </span>
      </div>
      <p className="text-xs text-slate-500">{reason}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={() => onChange(true)}
          disabled={isManual && activity.active}
          className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-200 disabled:opacity-40"
        >
          Mark active
        </button>
        <button
          onClick={() => onChange(false)}
          disabled={isManual && !activity.active}
          className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-200 disabled:opacity-40"
        >
          Mark inactive
        </button>
        {isManual && (
          <button
            onClick={() => onChange(null)}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-brand-600 hover:underline"
          >
            Use auto (sales-based)
          </button>
        )}
      </div>
    </div>
  );
}
