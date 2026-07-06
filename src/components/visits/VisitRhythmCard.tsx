"use client";

import { useMemo } from "react";
import { useMeetings } from "@/lib/meetings-store";
import { useRep } from "@/lib/rep";
import { useRestaurants } from "@/lib/store";
import { computeVenueSchedule, repForVenue, visitDatesForVenue } from "@/lib/visits/schedule";
import { detectIntervalShift } from "@/lib/visits/interval";
import { INTERVAL_WINDOW } from "@/lib/visits/config";
import { relativeDays } from "@/lib/visits/dates";
import { REMINDER_STATE_STYLE, VISIT_LABELS } from "@/lib/visits/types";
import type { Restaurant, VisitSettings } from "@/lib/types";

// "How often do we see them?" — the rep sets the target cadence here (manual
// input, per Mark's spec); the learned rhythm runs alongside as a reality
// check and powers when this venue gets suggested for a visit.

const FREQUENCY_OPTIONS = [
  { value: "auto", label: "Automatic — learn from visits" },
  { value: "7", label: "Every week" },
  { value: "14", label: "Every 2 weeks" },
  { value: "21", label: "Every 3 weeks" },
  { value: "30", label: "Every month" },
  { value: "42", label: "Every 6 weeks" },
  { value: "60", label: "Every 2 months" },
  { value: "91", label: "Every 3 months" },
  { value: "paused", label: "Paused — no visits planned" },
];

export function VisitRhythmCard({ r }: { r: Restaurant }) {
  const { updateRestaurant } = useRestaurants();
  const { meetings } = useMeetings();
  const { reps } = useRep();

  const { estimate, schedule } = useMemo(
    () => computeVenueSchedule(r, meetings),
    [r, meetings],
  );
  const shift = useMemo(
    () => detectIntervalShift(visitDatesForVenue(r, meetings), { windowSize: INTERVAL_WINDOW }),
    [r, meetings],
  );

  const vs = r.visitSettings;
  const selectValue =
    vs?.intervalMode === "paused"
      ? "paused"
      : vs?.intervalMode === "manual" && vs.manualIntervalDays
        ? String(vs.manualIntervalDays)
        : "auto";
  const isCustomValue = selectValue !== "auto" && selectValue !== "paused" &&
    !FREQUENCY_OPTIONS.some((o) => o.value === selectValue);

  function setFrequency(value: string) {
    let next: VisitSettings;
    if (value === "auto") {
      next = { ...vs, intervalMode: "automatic", manualIntervalDays: null, setupCompleted: true };
    } else if (value === "paused") {
      next = { ...vs, intervalMode: "paused", setupCompleted: true };
    } else {
      const days = parseInt(value, 10);
      next = {
        ...vs,
        intervalMode: "manual",
        manualIntervalDays: days,
        expectedIntervalDays: days,
        setupCompleted: true,
      };
    }
    updateRestaurant(r.id, { visitSettings: next });
  }

  const autoRep = repForVenue(r, reps);

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Visit rhythm</h2>
        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${REMINDER_STATE_STYLE[schedule.reminderState]}`}>
          {VISIT_LABELS.reminderState[schedule.reminderState]}
        </span>
      </div>

      <div className="space-y-3 text-sm">
        <div>
          <label className="mb-1 block text-xs text-slate-500">How often do you need to see them?</label>
          <select
            value={isCustomValue ? "custom" : selectValue}
            onChange={(e) => e.target.value !== "custom" && setFrequency(e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand-500"
          >
            {FREQUENCY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
            {isCustomValue && <option value="custom">Every {selectValue} days</option>}
          </select>
          <div className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-500">
            or every
            <input
              type="number"
              min={1}
              max={365}
              placeholder="n"
              className="w-16 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs outline-none focus:border-brand-500"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const days = parseInt((e.target as HTMLInputElement).value, 10);
                  if (days > 0) setFrequency(String(days));
                }
              }}
            />
            days <span className="text-slate-300">(press Enter)</span>
          </div>
        </div>

        <dl className="space-y-1.5 border-t border-slate-100 pt-3">
          <Row
            label="Learned rhythm"
            value={
              estimate.estimatedDays
                ? `${estimate.label} · ${estimate.confidence} confidence (${estimate.basedOnMeetings} visits)`
                : "Not enough visits yet"
            }
          />
          <Row
            label="Last visit"
            value={
              schedule.lastMeetingDate
                ? schedule.lastMeetingDate.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
                : "Never"
            }
          />
          <Row
            label="Next due"
            value={
              schedule.reminderState === "paused"
                ? "Paused"
                : schedule.nextSuggestedDate
                  ? `${schedule.nextSuggestedDate.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} (${relativeDays(schedule.daysUntilDue ?? 0)})`
                  : "Set a frequency or log a first visit"
            }
          />
        </dl>

        {shift.changed && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Rhythm change: visits have moved from {shift.fromLabel.toLowerCase()} to about{" "}
            {shift.toLabel.toLowerCase()} — worth checking the set frequency still fits.
          </p>
        )}

        <div className="border-t border-slate-100 pt-3">
          <label className="mb-1 block text-xs text-slate-500">On whose calendar?</label>
          <select
            value={r.assignedRepId ?? ""}
            onChange={(e) => updateRestaurant(r.id, { assignedRepId: e.target.value || undefined })}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand-500"
          >
            <option value="">
              {autoRep
                ? `Auto: ${autoRep.name} (from Power BI account manager)`
                : r.customerAccountManager
                  ? `Auto: unmatched — “${r.customerAccountManager}”`
                  : "Unassigned"}
            </option>
            {reps.map((rep) => (
              <option key={rep.id} value={rep.id}>{rep.name}</option>
            ))}
          </select>
          {!autoRep && r.customerAccountManager && reps.length > 0 && !r.assignedRepId && (
            <p className="mt-1 text-xs text-slate-400">
              Tip: add “{r.customerAccountManager}” as a Power BI alias in Settings → Sales team to match automatically.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-800">{value}</dd>
    </div>
  );
}
