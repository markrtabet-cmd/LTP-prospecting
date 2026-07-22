"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { EditableRep, repName } from "@/components/RepCell";
import { ChainBadge, HeadOfficeBadge, InactiveBadge, LeadBadge, OutreachBadge, RecommendBadge } from "@/components/StatusBadge";
import { VisitRhythmCard } from "@/components/visits/VisitRhythmCard";
import { isGroupHeadOffice } from "@/lib/groups";
import { MeetingsCard } from "@/components/visits/MeetingsCard";
import { ScheduleVisitModal } from "@/components/visits/ScheduleVisitModal";
import { RecordMeetingSheet } from "@/components/visits/RecordMeetingSheet";
import { CustomerInsightsCard } from "@/components/CustomerInsightsCard";
import { CustomerServiceEmails } from "@/components/CustomerServiceEmails";
import { CustomerEditor } from "@/components/CustomerEditor";
import { useCustomerInsights, type InsightsState } from "@/hooks/useCustomerInsights";
import { PRICE_LABELS } from "@/lib/mock-data";
import { detectChain } from "@/lib/chains";
import { displayArea } from "@/lib/locations";
import { useRestaurants } from "@/lib/store";
import { useRep } from "@/lib/rep";
import { ownsCustomer } from "@/lib/ownership";
import { dateKeyToLoggedIso, toDateKey } from "@/lib/visits/dates";
import { customerActivity, inactivityReasonLabel } from "@/lib/customer-activity";
import { visibleNotes } from "@/lib/activity-visibility";
import { deliveryDaysForPostcode, deliveryDaysForVenue } from "@/data/delivery-days";
import { assessProspectNote } from "@/lib/note-sentiment";
import { isAddedVenueId, venueWebsite } from "@/lib/types";
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
  // Resolve against the FULL list so an excluded (or non-London) venue's profile
  // — and its contact log / meetings — stays reachable by id, not just while it's
  // visible in the leads/map view.
  const { allRestaurants, updateRestaurant, removeRestaurant } = useRestaurants();
  const { me, reps, seesEverything } = useRep();
  const r = allRestaurants.find((x) => x.id === params.id);
  const [editingCustomer, setEditingCustomer] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  // Dynamic balance for the customer two-column layout: when the right column
  // (account/rhythm/meetings/notes/actions) runs meaningfully taller than the
  // left sales card, move the Notes & contact log under the sales card to even
  // the two columns out. The note-in-progress draft is lifted here so it
  // survives the card relocating between columns (which remounts ContactLog).
  const [notesUnderSales, setNotesUnderSales] = useState(false);
  const leftColRef = useRef<HTMLDivElement>(null);
  const rightColRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<HTMLDivElement>(null);
  const [noteDraft, setNoteDraft] = useState<{ author: string; text: string; date: string }>(
    () => ({ author: "", text: "", date: toDateKey(new Date()) }),
  );
  const rId = r?.id;
  const isCustomer = r?.existingCustomer ?? false;
  useEffect(() => {
    setNoteDraft({ author: "", text: "", date: toDateKey(new Date()) });
  }, [rId]);
  useEffect(() => {
    if (!isCustomer) { setNotesUnderSales(false); return; }
    const left = leftColRef.current, right = rightColRef.current;
    if (!left || !right || typeof ResizeObserver === "undefined") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!mq.matches) { setNotesUnderSales(false); return; }
        const leftH = left.offsetHeight, rightH = right.offsetHeight;
        const notesH = notesRef.current?.offsetHeight ?? 0;
        if (notesH < 40) return; // not measured yet
        const margin = notesH + 32; // hysteresis: cancels notesH so the test is
        // effectively "other-right stuff vs sales", preventing oscillation.
        setNotesUnderSales((cur) => (cur ? !(leftH - rightH > margin) : rightH - leftH > margin));
      });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(left); ro.observe(right);
    measure();
    const onResize = () => measure();
    mq.addEventListener?.("change", onResize);
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect(); cancelAnimationFrame(raf);
      mq.removeEventListener?.("change", onResize);
      window.removeEventListener("resize", onResize);
    };
  }, [isCustomer, rId]);
  // Which list the user arrived from (set by that list's ?from=… link) — drives
  // the back arrow's label and destination so "back" returns to that list, not
  // always /leads. The Customers list also restores its own scroll + filters
  // (session-persisted) so you land exactly where you were.
  const [from, setFrom] = useState<string | null>(null);
  useEffect(() => {
    setFrom(new URLSearchParams(window.location.search).get("from"));
  }, []);
  // A rep may see a customer's full record (sales, log, activity, actions) only
  // for their OWN accounts; on someone else's customer they see just contact
  // details. Admins/developers (seesEverything) always see everything. Computed
  // here (before the fetch) so a restricted view can request the contact-only
  // payload and the sales figures never leave the server.
  const meRepForOwnership = me ? reps.find((x) => x.id === me.id) ?? { id: me.id, name: me.name, aliases: [] as string[] } : null;
  const fullCustomerView = !!r && (seesEverything || (meRepForOwnership ? ownsCustomer(r, meRepForOwnership, reps) : false));
  // One shared live Power BI fetch for a customer, fed to the Sales/Account card,
  // the Contact card and the customer-service outreach. Idle (no request) for a
  // prospect or a not-found id. Restricted when a rep views a customer not theirs.
  const insights = useCustomerInsights(r && r.existingCustomer ? r : null, !!r && r.existingCustomer && !fullCustomerView);
  const BACK_LABEL: Record<string, string> = {
    customers: "Back to customers",
    leads: "Back to leads",
    activity: "Back to activity",
    dashboard: "Back to dashboard",
    insights: "Back to insights",
    "new-openings": "Back to new openings",
  };
  // Label reflects where we came from when known; a plain "Back" otherwise (we
  // still return to the exact previous page via history).
  const backLabel = (from && BACK_LABEL[from]) || "Back";
  const backHref = from ? `/${from}` : "/leads";
  // Return to the ACTUAL previous page (any list, the map, a search…), preserving
  // its scroll/filters — not always /leads. Next's App Router stores a position
  // index in history.state; idx>0 means we navigated here in-app, so a real back
  // is safe. Only when this profile was opened cold (deep link / new tab, idx 0)
  // do we fall back to the from-based list so "back" never steps off the app.
  function handleBack() {
    const idx = typeof window !== "undefined" ? (window.history.state?.idx as number | undefined) ?? 0 : 0;
    if (idx > 0) router.back();
    else router.push(backHref);
  }

  if (!r) {
    return (
      <div className="rounded-xl bg-white p-10 text-center text-slate-500 ring-1 ring-slate-200">
        Restaurant not found.{" "}
        <button onClick={handleBack} className="text-brand-600 hover:underline">
          {backLabel}
        </button>
      </div>
    );
  }

  function removeAsCustomer() {
    if (!r) return;
    if (!confirm(`Remove ${r.name} as a customer? It returns to the prospect pool (or is deleted if it was added manually).`)) return;
    // Mirror the Customers page: added records (r-user-/pbi-/open-) are deleted;
    // real FSA venues are just un-flagged so they fall back into the prospect pool.
    if (isAddedVenueId(r.id)) removeRestaurant(r.id);
    else updateRestaurant(r.id, { existingCustomer: false, outreachStatus: "not_contacted" });
    router.push("/customers");
  }

  const mapsHref = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${r.name} ${r.postcode}`)}`;
  const searchHref = `https://www.google.com/search?q=${encodeURIComponent(`${r.name} ${r.borough} restaurant`)}`;

  // Shared between the customer and prospect layouts (key by id so the log form
  // never carries state across profiles).
  const contactLog = (
    <ContactLog
      r={r}
      onChange={(log) => {
        // An emptied log clears the verdict in the SAME write — a separate
        // clear would race this one through /api/data's row-level merge.
        updateRestaurant(r.id, { contactLog: log, ...(log.length === 0 ? { noteSentiment: null } : {}) });
        // Re-judge the prospect's pursuit from the new latest note (covers add
        // AND remove) — fire-and-forget, colours the leads-page badge.
        void assessProspectNote(r, log, updateRestaurant);
      }}
      onRecord={() => setRecordOpen(true)}
      draft={noteDraft}
      onDraftChange={setNoteDraft}
    />
  );

  const actionsCard = (
    <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">Actions</h2>
      <div className="grid grid-cols-2 gap-2">
        <Action
          onClick={() => { updateRestaurant(r.id, { outreachStatus: "draft_ready" }); router.push("/emails"); }}
          className="bg-brand-500 text-white hover:bg-brand-600"
        >
          Generate email draft
        </Action>
        <Action onClick={() => setRecordOpen(true)} className="bg-indigo-50 text-indigo-700 hover:bg-indigo-100">Record note</Action>
        <Action onClick={() => setScheduleOpen(true)} className="bg-slate-100 text-slate-700 hover:bg-slate-200">Schedule visit</Action>
        <ActionLink href={mapsHref}>Google Maps ↗</ActionLink>
        <ActionLink href={searchHref}>Search web ↗</ActionLink>
        {r.existingCustomer ? (
          <Action onClick={removeAsCustomer} className="bg-red-50 text-red-700 hover:bg-red-100">Remove as customer</Action>
        ) : r.excluded ? (
          <Action onClick={() => updateRestaurant(r.id, { excluded: false })} className="bg-slate-100 text-slate-700 hover:bg-slate-200">Restore to leads</Action>
        ) : (
          <Action onClick={() => updateRestaurant(r.id, { excluded: true })} className="bg-red-50 text-red-700 hover:bg-red-100">Exclude from leads</Action>
        )}
      </div>
      {r.nextAction && <p className="mt-3 text-xs text-slate-400">Next action: {r.nextAction}</p>}
      <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
        {r.existingCustomer
          ? "Removing returns this account to the prospect pool (or deletes it if it was added manually)."
          : "Excluding hides this venue from leads, the map and reports for everyone — its notes and history are kept."}
      </p>
    </div>
  );

  return (
    <div>
      <button onClick={handleBack} className="mb-3 inline-flex items-center gap-1 text-sm text-brand-600 hover:underline">
        <span aria-hidden>←</span> {backLabel}
      </button>
      <PageHeader
        title={r.name}
        subtitle={`${r.cuisineType} · ${r.businessType} · ${displayArea(r)}`}
        action={
          <div className="flex items-center gap-3">
            {detectChain(r.name) && <ChainBadge brand={detectChain(r.name)!} />}
            {r.existingCustomer && (
              <span className="rounded bg-blue-100 px-2 py-1 text-xs font-medium text-blue-700">LTP customer</span>
            )}
            {isGroupHeadOffice(r) && <HeadOfficeBadge />}
            {r.existingCustomer && r.ownerGroup && (
              <span className="rounded bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700 ring-1 ring-indigo-200" title="Owner / operator group (from Power BI)">{r.ownerGroup}</span>
            )}
            {r.existingCustomer && !customerActivity(r).active && <InactiveBadge reason={fullCustomerView ? inactivityReasonLabel(r) : null} />}
            {r.existingCustomer && seesEverything && (
              <button
                onClick={() => setEditingCustomer((v) => !v)}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                title="Edit this customer's details (persists across Power BI syncs)"
              >
                {editingCustomer ? "Close editor" : "Edit customer"}
              </button>
            )}
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

      {r.existingCustomer && seesEverything && editingCustomer && (
        <div className="mb-6 rounded-xl bg-white p-5 shadow-sm ring-1 ring-brand-200">
          <h2 className="mb-1 text-sm font-semibold text-slate-900">Edit customer</h2>
          <p className="mb-4 text-xs text-slate-500">
            Corrects the profile and fixes a wrong location (change the postcode to re-pin). Saved edits persist across the
            nightly Power BI sync — they win over Centric where you fill something in.
          </p>
          <CustomerEditor
            mode="edit"
            venueId={r.id}
            initial={{
              name: r.name,
              accountCode: r.customerAccountCode ?? "",
              postcode: r.postcode,
              address: r.address ?? "",
              contactName: r.customerContactName ?? "",
              phone: r.customerContactPhone ?? r.phone ?? "",
              email: r.customerContactEmail ?? r.email ?? "",
              sector: r.sector ?? "",
              accountManager: r.customerAccountManager ?? "",
              businessType: r.businessType,
              cuisineType: r.cuisineType,
            }}
            onDone={() => setEditingCustomer(false)}
            onCancel={() => setEditingCustomer(false)}
          />
        </div>
      )}

      {r.existingCustomer ? (
        // ===== CUSTOMER: sales big on the left; account/contact/service, visit
        // rhythm, meetings, notes and actions grouped in the sidebar. =====
        <div className="grid gap-6 lg:grid-cols-5">
          <div ref={leftColRef} className="space-y-6 lg:col-span-3">
            {fullCustomerView && <CustomerInsightsCard state={insights} />}
            {fullCustomerView && notesUnderSales && <div ref={notesRef}>{contactLog}</div>}
          </div>
          <div ref={rightColRef} className="space-y-6 lg:col-span-2">
            {/* A non-owning rep sees ONLY the contact details (restricted card) —
                no sales, log, visit rhythm, meetings or actions. */}
            <CustomerAccountContactCard r={r} state={insights} author={me?.name ?? ""} restricted={!fullCustomerView} />
            {fullCustomerView && <VisitRhythmCard r={r} />}
            {fullCustomerView && <MeetingsCard venueId={r.id} />}
            {fullCustomerView && !notesUnderSales && <div ref={notesRef}>{contactLog}</div>}
            {fullCustomerView && actionsCard}
          </div>
        </div>
      ) : (
        // ===== PROSPECT: lead-score breakdown + evidence + activity on the left;
        // contact/status and actions in the sidebar. =====
        <div className="grid gap-6 lg:grid-cols-5">
          <div className="space-y-6 lg:col-span-3">
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
            <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
              <h2 className="mb-3 text-sm font-semibold text-slate-900">Source evidence</h2>
              <p className="text-sm text-slate-600">{r.source}</p>
              {r.openingEvidence && <p className="mt-1 text-sm text-slate-500">{r.openingEvidence}</p>}
            </div>
            <MeetingsCard venueId={r.id} />
            {contactLog}
          </div>
          <div className="space-y-6 lg:col-span-2">
            <LeadInfoCard r={r} />
            {actionsCard}
          </div>
        </div>
      )}

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
function ContactLog({ r, onChange, onRecord, draft, onDraftChange }: { r: Restaurant; onChange: (log: ContactNote[]) => void; onRecord: () => void; draft: { author: string; text: string; date: string }; onDraftChange: (d: { author: string; text: string; date: string }) => void }) {
  const log = r.contactLog ?? [];
  const { me, reps, seesEverything } = useRep();
  const meRep = me ? reps.find((x) => x.id === me.id) ?? { id: me.id, name: me.name, aliases: [] as string[] } : null;
  // A rep only sees their own notes; admins/devs see everyone's.
  const visibleLog = visibleNotes(log, { rep: meRep, seesEverything });
  // Draft state is lifted to the parent so it survives the card being relocated
  // between the two columns (which remounts this component).
  const { author, text, date } = draft;
  const setAuthor = (v: string) => onDraftChange({ ...draft, author: v });
  const setText = (v: string) => onDraftChange({ ...draft, text: v });
  const setDate = (v: string) => onDraftChange({ ...draft, date: v });

  function add() {
    const body = text.trim();
    if (!body) return;
    const note: ContactNote = {
      id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${r.id}-${log.length}-${new Date().toISOString()}`,
      author: author.trim() || "Sales team",
      text: body,
      at: dateKeyToLoggedIso(date),
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

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// A slate action styled to sit in the Actions grid alongside <Action> buttons,
// but as an external link (Google Maps / Search web).
function ActionLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="rounded-lg bg-slate-100 px-3 py-2 text-center text-sm font-medium text-slate-700 transition hover:bg-slate-200"
    >
      {children}
    </a>
  );
}

function gbp(n: number): string {
  return `£${Math.round(n).toLocaleString("en-GB")}`;
}

function StatusChip({ status }: { status: string }) {
  const active = status.trim().toUpperCase() === "ACTIVE";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${active ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
      {titleCase(status)}
    </span>
  );
}

function Fact({ label, value, node }: { label: string; value?: string; node?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-50 pb-1.5">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-800">{node ?? value}</dd>
    </div>
  );
}

// The customer sidebar's combined panel: account details (address, delivery days
// and the live Power BI account facts) → contacts → customer-service outreach,
// grouped in one card per the profile layout. Fed by the shared
// useCustomerInsights state; falls back to the venue's own synced contact fields
// when Power BI hasn't resolved.
function CustomerAccountContactCard({ r, state, author, restricted = false }: { r: Restaurant; state: InsightsState; author: string; restricted?: boolean }) {
  const a = state.status === "ready" ? state.data.account : undefined;
  const contacts = state.status === "ready" ? state.data.contacts : [];
  const site = venueWebsite(r);
  const delivery = deliveryDaysForVenue(r);
  const busy = state.status === "loading" || state.status === "idle";
  return (
    <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-900">Account &amp; contact</h2>
        {state.status === "ready" && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
            </span>
            Live from Power BI
          </span>
        )}
      </div>

      {/* Account details */}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Fact label="Address" value={[r.address, r.postcode].filter(Boolean).join(", ") || "—"} />
        <Fact label="Delivery days" value={delivery || "—"} />
        <Fact label="Sales rep" node={repName(r) ? repName(r) : <EditableRep r={r} />} />
        {/* Commercial/account facts are hidden for a rep viewing another rep's
            customer (restricted): they see contact details only. */}
        {a && !restricted && (
          <>
            <Fact label="Account manager" value={a.salesRep ? titleCase(a.salesRep) : r.customerAccountManager || "—"} />
            <Fact label="Status" node={a.accountStatus ? <StatusChip status={a.accountStatus} /> : "—"} />
            <Fact label="Customer group" value={a.customerGroup || "—"} />
            <Fact label="Payment method" value={a.paymentMethod || "—"} />
            <Fact label="Terms" value={a.terms || "—"} />
            <Fact label="Price list" value={a.priceList || "—"} />
            <Fact label="Min order" value={a.minOrder != null ? gbp(a.minOrder) : "—"} />
            <Fact label="Last route" value={a.lastRoute || "—"} />
          </>
        )}
      </dl>

      {/* Contacts */}
      <div className="mt-4 border-t border-slate-100 pt-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Contact</p>
        {a?.mainPhone && (
          <p className="mb-2 text-sm">
            <span className="text-slate-500">Main phone: </span>
            <a className="text-brand-600 hover:underline" href={`tel:${a.mainPhone}`}>{a.mainPhone}</a>
          </p>
        )}
        {busy ? (
          <div className="flex h-14 items-center justify-center">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-200 border-t-brand-500" />
          </div>
        ) : contacts.length > 0 ? (
          <div className="grid gap-2">
            {contacts.map((c, i) => (
              <div key={i} className="rounded-xl bg-slate-50 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-800">{c.name ? titleCase(c.name) : "Contact"}</p>
                  {c.role && <span className="shrink-0 text-xs text-slate-400">{titleCase(c.role)}</span>}
                </div>
                {(c.phone1 || c.phone2) && (
                  <p className="mt-1 text-sm">
                    {[c.phone1, c.phone2].filter(Boolean).map((p) => (
                      <a key={p} href={`tel:${p}`} className="mr-3 text-brand-600 hover:underline">{p}</a>
                    ))}
                  </p>
                )}
                {c.email && (
                  <p className="mt-0.5 text-sm">
                    <a href={`mailto:${c.email}`} className="break-all text-brand-600 hover:underline">{c.email.toLowerCase()}</a>
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <dl className="space-y-2 text-sm">
            <Row label="Contact" value={r.customerContactName || "—"} />
            <Row
              label="Email"
              node={r.customerContactEmail || r.email
                ? <a className="text-brand-600 hover:underline" href={`mailto:${r.customerContactEmail || r.email}`}>{r.customerContactEmail || r.email}</a>
                : "—"}
            />
            <Row
              label="Phone"
              node={r.customerContactPhone || r.phone
                ? <a className="text-brand-600 hover:underline" href={`tel:${r.customerContactPhone || r.phone}`}>{r.customerContactPhone || r.phone}</a>
                : "—"}
            />
          </dl>
        )}
        {site && (
          <div className="mt-2 text-sm">
            <a className="text-brand-600 hover:underline" href={site} target="_blank" rel="noreferrer">Visit website ↗</a>
          </div>
        )}
      </div>

      {/* Customer service — joined onto the bottom of the contacts. Hidden for a
          rep viewing another rep's customer (they get contact details only). */}
      {!restricted && (
        <div className="mt-4 border-t border-slate-100 pt-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Customer service</p>
          <CustomerServiceEmails
            r={r}
            phone={r.customerContactPhone || r.phone}
            email={r.customerContactEmail || r.email}
            author={author}
            contacts={contacts.length ? contacts : undefined}
          />
        </div>
      )}
    </div>
  );
}

// Contact & status card for a PROSPECT (non-customer). Customers get the live
// Power BI CustomerContactCard instead; this keeps the venue's own contact
// details, price/hygiene and outreach status for leads. Google Maps / Search web
// have moved to the shared Actions card.
function LeadInfoCard({ r }: { r: Restaurant }) {
  const site = venueWebsite(r);
  const delivery = deliveryDaysForPostcode(r.postcode);
  return (
    <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">Contact &amp; status</h2>
      <dl className="space-y-2 text-sm">
        <Row label="Address" value={`${r.address}, ${r.postcode}`} />
        {delivery && <Row label="Delivery days" value={delivery} />}
        <Row label="Email" node={r.email ? <a className="text-brand-600 hover:underline" href={`mailto:${r.email}`}>{r.email}</a> : "—"} />
        <Row label="Phone" node={r.phone ? <a className="text-brand-600 hover:underline" href={`tel:${r.phone}`}>{r.phone}</a> : "—"} />
        <Row label="Website" node={site ? <a className="text-brand-600 hover:underline" href={site} target="_blank" rel="noreferrer">Visit site ↗</a> : "—"} />
        <Row label="Price point" value={PRICE_LABELS[r.priceTier]} />
        <Row label="Hygiene rating" value={r.hygieneRating ? `${r.hygieneRating}/5` : "—"} />
        <Row label="Assigned to" value={r.assignedOwner ?? "Unassigned"} />
      </dl>
      <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3">
        <span className="text-sm text-slate-500">Outreach</span>
        <OutreachBadge status={r.outreachStatus} />
      </div>
    </div>
  );
}
