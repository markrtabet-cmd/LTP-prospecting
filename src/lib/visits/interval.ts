// ============================================================================
// Smart interval engine (PRD §7).
//
// Goal: learn how often each client is normally met, from the gaps between
// COMPLETED meetings, and adapt gradually when the rhythm changes — without
// overreacting to a single late/early meeting.
//
// Approach (deliberately simple, deterministic & debuggable, per PRD §7.5):
//   1. Compute the day-gap between each pair of consecutive meetings.
//   2. Keep the most recent N gaps (window, default 5).
//   3. Drop clear outliers inside that window (a single freak gap).
//   4. Take a weighted average where the NEWEST gap counts most.
//   5. Round to a human-readable label (Weekly / Monthly / Every 2 months …).
//
// Being a stateless recomputation (rather than a stored running average) means
// editing or deleting a meeting always yields a correct, reproducible estimate.
//
// This module is PURE (no I/O) so it can be unit-tested in isolation.
// ============================================================================

import { diffInDays } from "./dates";

export type Confidence = "low" | "medium" | "high";

export interface IntervalEstimate {
  /** Weighted-average interval in whole days, or null if not yet computable. */
  estimatedDays: number | null;
  /** Human-readable label for `estimatedDays` (e.g. "Monthly"). */
  label: string;
  confidence: Confidence;
  /** 0..1 numeric confidence (PRD §7.6). */
  confidenceScore: number;
  /** Number of completed meetings the estimate is based on. */
  basedOnMeetings: number;
  /** All consecutive gaps in days, oldest → newest. */
  observedIntervals: number[];
  /** Gaps actually used after windowing + outlier removal, oldest → newest. */
  usedIntervals: number[];
  /** Gaps excluded from the window as outliers. */
  outliersRemoved: number[];
}

export interface EstimateOptions {
  /** Consider only the most recent N gaps (PRD §7.5 says 3–5). Default 5. */
  windowSize?: number;
}

// Human-readable interval bands. The first band whose centre is within
// `tolerance` days of the estimate wins (bands are ordered shortest first).
export const HUMAN_INTERVAL_BANDS: ReadonlyArray<{
  label: string;
  days: number;
  tolerance: number;
}> = [
  { label: "Weekly", days: 7, tolerance: 2 },
  { label: "Every 2 weeks", days: 14, tolerance: 3 },
  { label: "Every 3 weeks", days: 21, tolerance: 4 },
  { label: "Monthly", days: 30, tolerance: 6 },
  { label: "Every 6 weeks", days: 42, tolerance: 6 },
  { label: "Every 2 months", days: 60, tolerance: 10 },
  { label: "Quarterly", days: 91, tolerance: 16 },
  { label: "Every 4 months", days: 122, tolerance: 18 },
  { label: "Twice a year", days: 182, tolerance: 25 },
  { label: "Yearly", days: 365, tolerance: 45 },
];

/** Map a number of days to a friendly label (PRD §7.3). */
export function humanIntervalLabel(days: number | null | undefined): string {
  if (days == null || !Number.isFinite(days) || days <= 0) return "Not enough data";
  const rounded = Math.round(days);
  for (const band of HUMAN_INTERVAL_BANDS) {
    if (Math.abs(rounded - band.days) <= band.tolerance) return band.label;
  }
  return `Every ${rounded} days`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Drop clear outliers from a window of gaps. A gap is an outlier when it is
 * more than 2.5× the window median or less than 0.4× it. We only filter when
 * there are enough points (>= 4) and we always keep at least 2 gaps so one
 * unusual meeting can't wipe out the signal (PRD §7.4 "treat as possible
 * outlier, don't overreact").
 */
function removeOutliers(window: number[]): {
  kept: number[];
  removed: number[];
} {
  if (window.length < 4) return { kept: window, removed: [] };
  const med = median(window);
  if (med <= 0) return { kept: window, removed: [] };
  const hi = med * 2.5;
  const lo = med * 0.4;
  const kept: number[] = [];
  const removed: number[] = [];
  for (const g of window) {
    if (g > hi || g < lo) removed.push(g);
    else kept.push(g);
  }
  if (kept.length < 2) return { kept: window, removed: [] };
  return { kept, removed };
}

/**
 * Weighted average where newer gaps count more. For k gaps in chronological
 * order (oldest → newest) weights are 1,2,…,k so the newest gap dominates.
 * For 3 gaps this gives 17% / 33% / 50% — i.e. the most recent interval carries
 * the most weight, matching PRD §7.5's "recent counts more" example.
 */
function weightedAverage(gapsOldestToNewest: number[]): number {
  let weightedSum = 0;
  let weightTotal = 0;
  gapsOldestToNewest.forEach((gap, i) => {
    const weight = i + 1;
    weightedSum += gap * weight;
    weightTotal += weight;
  });
  return weightTotal === 0 ? 0 : weightedSum / weightTotal;
}

/**
 * Estimate a client's normal meeting interval from their completed meeting
 * dates. Dates may be in any order; they are sorted ascending internally.
 */
export function estimateInterval(
  meetingDates: Date[],
  options: EstimateOptions = {},
): IntervalEstimate {
  const windowSize = options.windowSize ?? 5;
  const basedOnMeetings = meetingDates.length;

  // Sort ascending and compute consecutive gaps (whole days).
  const sorted = [...meetingDates].sort((a, b) => a.getTime() - b.getTime());
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const g = diffInDays(sorted[i], sorted[i - 1]);
    // Guard against duplicate/same-day entries producing a 0-day gap.
    if (g > 0) gaps.push(g);
  }

  if (gaps.length === 0) {
    return {
      estimatedDays: null,
      label: "Not enough data",
      confidence: "low",
      confidenceScore: basedOnMeetings >= 1 ? 0.1 : 0,
      basedOnMeetings,
      observedIntervals: [],
      usedIntervals: [],
      outliersRemoved: [],
    };
  }

  // Most recent `windowSize` gaps (still oldest → newest within the window).
  const window = gaps.slice(Math.max(0, gaps.length - windowSize));
  const { kept: usedIntervals, removed: outliersRemoved } = removeOutliers(window);

  const estimatedDays = Math.round(weightedAverage(usedIntervals));

  // ---- Confidence (PRD §7.6) -----------------------------------------------
  // Blend "how much data" with "how consistent the data is".
  // Count evidence by the number of *intervals* observed (gaps), not the raw
  // meeting count, so same-day/duplicate meetings (which add no gap) don't
  // inflate confidence. Equals (basedOnMeetings - 1) / 5 when there are no
  // same-day duplicates.
  const countScore = Math.min(1, gaps.length / 5); // 6+ spaced meetings → 1
  const m = mean(usedIntervals);
  const cv =
    m > 0 && usedIntervals.length >= 2
      ? Math.sqrt(
          usedIntervals.reduce((s, v) => s + (v - m) ** 2, 0) /
            usedIntervals.length,
        ) / m
      : usedIntervals.length < 2
        ? 1 // a single gap → treat as inconsistent (low confidence)
        : 0;
  const consistencyScore = Math.max(0, Math.min(1, 1 - cv));

  let confidenceScore: number;
  if (gaps.length < 2) {
    // Only one observed interval (2 meetings) → inherently low confidence.
    confidenceScore = Math.min(0.35, 0.2 + 0.15 * countScore);
  } else {
    confidenceScore = 0.5 * countScore + 0.5 * consistencyScore;
  }
  confidenceScore = Math.max(0, Math.min(1, confidenceScore));

  const confidence: Confidence =
    confidenceScore >= 0.7 ? "high" : confidenceScore >= 0.4 ? "medium" : "low";

  return {
    estimatedDays,
    label: humanIntervalLabel(estimatedDays),
    confidence,
    confidenceScore: Math.round(confidenceScore * 100) / 100,
    basedOnMeetings,
    observedIntervals: gaps,
    usedIntervals,
    outliersRemoved,
  };
}

export interface IntervalShift {
  changed: boolean;
  fromDays: number | null;
  toDays: number | null;
  fromLabel: string;
  toLabel: string;
}

/**
 * Detect whether a client's rhythm has recently shifted (PRD/dashboard signal).
 * Compares the estimate *before* the latest meeting with the estimate *after*
 * it; flags a change only when the human label actually moves AND the magnitude
 * is meaningful (>=40% slower or <=70% of the old pace). Needs >= 4 meetings so
 * we don't react to a single early data point.
 */
export function detectIntervalShift(
  meetingDates: Date[],
  options: EstimateOptions = {},
): IntervalShift {
  const none: IntervalShift = {
    changed: false,
    fromDays: null,
    toDays: null,
    fromLabel: "",
    toLabel: "",
  };
  if (meetingDates.length < 4) return none;

  const sorted = [...meetingDates].sort((a, b) => a.getTime() - b.getTime());
  const prior = estimateInterval(sorted.slice(0, -1), options);
  const current = estimateInterval(sorted, options);
  if (prior.estimatedDays == null || current.estimatedDays == null) return none;

  const ratio = current.estimatedDays / prior.estimatedDays;
  const fromLabel = humanIntervalLabel(prior.estimatedDays);
  const toLabel = humanIntervalLabel(current.estimatedDays);
  const changed = (ratio >= 1.4 || ratio <= 0.7) && fromLabel !== toLabel;

  return {
    changed,
    fromDays: prior.estimatedDays,
    toDays: current.estimatedDays,
    fromLabel,
    toLabel,
  };
}
