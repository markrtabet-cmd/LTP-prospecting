"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  Calendar as CalendarIcon,
  Check,
  Loader2,
  PackageX,
  Sparkles,
  TrendingDown,
  Users,
} from "lucide-react";
import { useMeetings } from "@/lib/meetings-store";
import { useRestaurants } from "@/lib/store";
import { useRep } from "@/lib/rep";
import { fmtShortDay, fromDateKey, toDateKey } from "@/lib/visits/dates";
import { buildAcceptedMeeting, buildSnoozePatch } from "@/lib/visits/mutations";
import type { Suggestion, SuggestionUrgency } from "@/lib/visits/suggestions";
import type { SalesAlertType } from "@/lib/visits/sales-health";

const URGENCY_STYLE: Record<SuggestionUrgency, { row: string; badge: string; label: string }> = {
  missed: { row: "bg-red-50 ring-1 ring-red-200", badge: "bg-red-100 text-red-700", label: "Missed" },
  late: { row: "bg-amber-50", badge: "bg-amber-100 text-amber-700", label: "Overdue" },
  due: { row: "bg-brand-50/70", badge: "bg-brand-100 text-brand-700", label: "Due" },
  soon: { row: "bg-slate-50", badge: "bg-slate-100 text-slate-600", label: "Coming up" },
};

// A Power BI sales flag outranks the row's timing look — a stronger reason to
// visit than the calendar rhythm alone.
const SALES_STYLE = {
  high: { row: "bg-rose-50 ring-1 ring-rose-200", badge: "bg-rose-100 text-rose-700" },
  medium: { row: "bg-rose-50/60", badge: "bg-rose-100 text-rose-700" },
} as const;

const SALES_ICON: Record<SalesAlertType, typeof TrendingDown> = {
  volume_drop: TrendingDown,
  stopped_ordering: PackageX,
  product_switch: ArrowLeftRight,
};

// Why a visit is being suggested — drives the panel's reason filters. Every
// suggestion has a timing reason (overdue vs due/soon), plus any Power BI sales
// flags, plus "nearby" when it batches with other visits already booked that day.
type ReasonKey = "overdue" | "due" | SalesAlertType | "nearby";

const REASON_META: { key: ReasonKey; label: string }[] = [
  { key: "overdue", label: "Overdue" },
  { key: "due", label: "Due soon" },
  { key: "volume_drop", label: "Ordering down" },
  { key: "stopped_ordering", label: "Gone quiet" },
  { key: "product_switch", label: "Product switch" },
  { key: "nearby", label: "Nearby that day" },
];

function reasonsFor(s: Suggestion): ReasonKey[] {
  const reasons: ReasonKey[] = [
    s.urgency === "missed" || s.urgency === "late" ? "overdue" : "due",
  ];
  for (const a of s.salesAlerts) reasons.push(a.type);
  if (s.suggestedBatchCount > 0) reasons.push("nearby");
  return reasons;
}

const LATER_PRESETS = [
  { days: 1, label: "Tomorrow" },
  { days: 3, label: "In 3 days" },
  { days: 7, label: "In a week" },
];

function timingText(s: Suggestion): string {
  const d = s.daysUntilDue;
  if (d == null) return "";
  if (d < 0) return `${-d} day${d === -1 ? "" : "s"} overdue`;
  if (d === 0) return "due today";
  return `due in ${d} day${d === 1 ? "" : "s"}`;
}

// One suggestion — the row plus its inline "book" / "not now" editors.
function SuggestionRow({ s, defaultDateKey }: { s: Suggestion; defaultDateKey?: string }) {
  const { addMeeting } = useMeetings();
  const { restaurants, updateRestaurant } = useRestaurants();
  const { me } = useRep();
  const [mode, setMode] = useState<"none" | "schedule" | "later">("none");
  const [scheduleDate, setScheduleDate] = useState("");

  const today = toDateKey(new Date());

  function openSchedule() {
    const base = defaultDateKey ?? s.suggestedDate;
    setScheduleDate(base >= today ? base : today);
    setMode((m) => (m === "schedule" ? "none" : "schedule"));
  }

  function accept(dateKey?: string) {
    if (!me) return;
    addMeeting(buildAcceptedMeeting({ repId: me.id, repName: me.name, suggestion: s, dateKey }));
    setMode("none");
  }

  function snooze(action: "push" | "skip", days?: number) {
    const venue = restaurants.find((r) => r.id === s.venueId);
    if (!venue) return;
    const patch = buildSnoozePatch({ action, days, intervalDays: s.effectiveIntervalDays });
    updateRestaurant(venue.id, {
      visitSettings: { intervalMode: "automatic", ...venue.visitSettings, ...patch },
    });
    setMode("none");
  }

  const topAlert = s.salesAlerts[0] ?? null;
  const highAlert = s.salesAlerts.some((a) => a.severity === "high");
  const st = URGENCY_STYLE[s.urgency];
  const rowClass = highAlert ? SALES_STYLE.high.row : topAlert ? SALES_STYLE.medium.row : st.row;
  const flagged = s.urgency === "missed" || highAlert;
  const metaLine = [
    timingText(s),
    s.lastMeetingDate ? `last seen ${fmtShortDay(new Date(s.lastMeetingDate))}` : "",
    s.intervalLabel && s.intervalLabel !== "Not enough data" ? `usually ${s.intervalLabel.toLowerCase()}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className={`rounded-xl px-3.5 py-2.5 ${rowClass}`}>
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-slate-900">
            {flagged && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-600" />}
            <span className="truncate">{s.venueName}</span>
            {topAlert ? (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${SALES_STYLE[topAlert.severity].badge}`}>
                Needs a visit
              </span>
            ) : (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${st.badge}`}>{st.label}</span>
            )}
          </p>

          {/* Why Power BI flagged them */}
          {s.salesAlerts.map((a, i) => {
            const Icon = SALES_ICON[a.type];
            return (
              <p key={i} className="mt-0.5 flex items-start gap-1.5 text-xs text-rose-700">
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  <span className="font-medium">{a.title}.</span> {a.detail}
                </span>
              </p>
            );
          })}

          {metaLine && <p className="mt-0.5 text-xs text-slate-500">{metaLine}</p>}

          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
            <CalendarIcon className="h-3.5 w-3.5 text-brand-500" />
            <span className="font-medium text-slate-800">Suggested: {fmtShortDay(fromDateKey(s.suggestedDate))}</span>
            {s.suggestedBatchCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] text-brand-700">
                <Users className="h-3 w-3" />
                with {s.suggestedBatchCount} other visit{s.suggestedBatchCount === 1 ? "" : "s"} that day
              </span>
            )}
          </p>
        </div>

        <button
          onClick={() => accept()}
          className="flex items-center gap-1 rounded-lg bg-brand-500 px-2.5 py-1.5 text-xs font-semibold text-white active:scale-95"
          title="Book it on the suggested day"
        >
          <Check className="h-3.5 w-3.5" /> Accept
        </button>
        <button
          onClick={openSchedule}
          className="rounded-lg bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 ring-1 ring-slate-200 active:scale-95"
        >
          Another day
        </button>
        <button
          onClick={() => setMode((m) => (m === "later" ? "none" : "later"))}
          className="px-2 py-1.5 text-xs text-slate-400 active:text-slate-700"
          title="Remind me later or skip this cycle"
        >
          Not now
        </button>
      </div>

      {mode === "schedule" && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-white/70 px-3 py-2">
          <span className="text-xs text-slate-500">Book for:</span>
          <input
            type="date"
            value={scheduleDate}
            onChange={(e) => setScheduleDate(e.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs outline-none"
          />
          <button
            onClick={() => scheduleDate && accept(scheduleDate)}
            className="flex items-center gap-1 rounded-lg bg-brand-500 px-2.5 py-1 text-xs font-semibold text-white active:scale-95"
          >
            <Check className="h-3.5 w-3.5" /> Accept
          </button>
          <button onClick={() => setMode("none")} className="text-xs text-slate-400">
            Cancel
          </button>
        </div>
      )}

      {mode === "later" && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-lg bg-white/70 px-3 py-2">
          <span className="mr-1 text-xs text-slate-500">Remind me:</span>
          {LATER_PRESETS.map((p) => (
            <button
              key={p.days}
              onClick={() => snooze("push", p.days)}
              className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 transition-colors active:border-brand-300 active:bg-brand-50 active:text-brand-700"
            >
              {p.label}
            </button>
          ))}
          <span className="mx-1 text-slate-300">|</span>
          <button
            onClick={() => snooze("skip")}
            className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 active:border-red-300 active:bg-red-50 active:text-red-700"
            title="Skip this cycle — don't suggest again until next time"
          >
            Skip this visit
          </button>
        </div>
      )}
    </div>
  );
}

export function SuggestionsPanel({
  suggestions,
  title,
  emptyText,
  loading,
  defaultDateKey,
}: {
  suggestions: Suggestion[];
  title: string;
  emptyText: string;
  loading?: boolean;
  /** Pre-fill "Another day" with this date instead of the smart suggestion. */
  defaultDateKey?: string;
}) {
  // Reason filters — every reason is on by default; tapping a chip hides
  // suggestions whose only reasons are switched off. Chips only appear for the
  // reasons actually present, and only when there's more than one to choose from.
  const [off, setOff] = useState<Set<ReasonKey>>(new Set());
  const toggle = (k: ReasonKey) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const presentReasons = useMemo(() => {
    const present = new Set<ReasonKey>();
    for (const s of suggestions) for (const r of reasonsFor(s)) present.add(r);
    return REASON_META.filter((m) => present.has(m.key));
  }, [suggestions]);

  const shown = useMemo(
    () => suggestions.filter((s) => reasonsFor(s).some((r) => !off.has(r))),
    [suggestions, off],
  );

  const missedCount = shown.filter((s) => s.urgency === "missed" && s.salesAlerts.length === 0).length;
  const salesCount = shown.filter((s) => s.salesAlerts.length > 0).length;

  return (
    <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-brand-500" />
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-300" />}
      </div>

      {presentReasons.length >= 2 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {presentReasons.map((m) => {
            const on = !off.has(m.key);
            return (
              <button
                key={m.key}
                onClick={() => toggle(m.key)}
                aria-pressed={on}
                className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition-colors ${
                  on
                    ? "bg-brand-50 text-brand-700 ring-brand-200"
                    : "bg-white text-slate-400 ring-slate-200 line-through"
                }`}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      )}

      {salesCount > 0 && (
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-rose-100 px-3 py-2 text-sm font-medium text-rose-800">
          <TrendingDown className="h-4 w-4 shrink-0" />
          {salesCount} venue{salesCount === 1 ? "" : "s"} flagged from sales — ordering has dropped, stopped, or
          changed. Worth a catch-up.
        </div>
      )}
      {missedCount > 0 && (
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-red-100 px-3 py-2 text-sm font-medium text-red-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {missedCount} visit{missedCount === 1 ? "" : "s"} fully missed — accept a date or skip{" "}
          {missedCount === 1 ? "it" : "them"}.
        </div>
      )}

      {shown.length === 0 ? (
        <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-400">
          {suggestions.length > 0 ? "No suggestions match the selected reasons." : emptyText}
        </p>
      ) : (
        <div className="space-y-2">
          {shown.map((s) => (
            <SuggestionRow key={s.venueId} s={s} defaultDateKey={defaultDateKey} />
          ))}
        </div>
      )}
    </div>
  );
}
