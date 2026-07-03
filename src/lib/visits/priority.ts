// ============================================================================
// Visit-priority engine.
//
// Answers "who should the rep visit first?" with a 0–100 score built from the
// three signals the business cares about:
//
//   1. TIMING    (50%) — how far past (or close to) their normal visit date
//                 they are, measured RELATIVE to their own rhythm. Being 10
//                 days late on a weekly client is far worse than on a
//                 quarterly one.
//   2. VALUE     (30%) — how much the client is worth per year (typed by the
//                 rep or synced from Power BI). Log-scaled so a £100k client
//                 doesn't completely drown out every £5k one.
//   3. FREQUENCY (20%) — how often they're normally visited. Clients you see
//                 weekly depend on the relationship more than yearly ones.
//
// Pure functions only — no I/O — so it's easy to test and reason about.
// ============================================================================

import type { PriorityLevel, ReminderState } from "./types";

export interface PriorityInput {
  reminderState: ReminderState;
  /** The interval actually in use (learned / manual / expected / default). */
  effectiveIntervalDays: number | null;
  /** Days until the suggested visit (negative = overdue), null when unknown. */
  daysUntilDue: number | null;
  /** Rough yearly value of the client in £, if known. */
  annualValue: number | null;
}

export interface PriorityResult {
  /** 0–100 combined score; higher = visit sooner. */
  score: number;
  level: PriorityLevel;
  /** Component scores (0–1), useful for explaining the ranking in the UI. */
  parts: { timing: number; value: number; frequency: number };
}

const WEIGHTS = { timing: 0.5, value: 0.3, frequency: 0.2 } as const;

// Frequency scale anchors: weekly (7d) → 1, yearly (365d) → 0, log in between.
const FREQ_MIN_DAYS = 7;
const FREQ_MAX_DAYS = 365;

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Timing: 0 when a visit just happened, climbing to 0.5 as the next suggested
 * date approaches, then 0.5 → 1 as the client becomes up to a FULL interval
 * overdue. "A full interval late" is the natural ceiling: at that point they've
 * effectively missed a whole visit, whatever their rhythm is.
 */
export function timingScore(
  daysUntilDue: number | null,
  intervalDays: number | null,
): number {
  if (daysUntilDue == null || intervalDays == null || intervalDays <= 0) return 0;
  if (daysUntilDue >= 0) {
    return clamp01(1 - daysUntilDue / intervalDays) * 0.5;
  }
  const overdueRatio = -daysUntilDue / intervalDays;
  return 0.5 + clamp01(overdueRatio) * 0.5;
}

/**
 * Value: log-scaled against a reference "top client" value so the scale suits
 * both corner delis and national distributors. £0/unknown → 0, reference → 1.
 */
export function valueScore(
  annualValue: number | null,
  referenceValue: number,
): number {
  if (annualValue == null || annualValue <= 0 || referenceValue <= 0) return 0;
  return clamp01(Math.log10(annualValue + 1) / Math.log10(referenceValue + 1));
}

/** Frequency: weekly rhythm → 1, yearly → 0, log-spaced in between. */
export function frequencyScore(intervalDays: number | null): number {
  if (intervalDays == null || intervalDays <= 0) return 0;
  const d = Math.min(Math.max(intervalDays, FREQ_MIN_DAYS), FREQ_MAX_DAYS);
  return clamp01(
    (Math.log(FREQ_MAX_DAYS) - Math.log(d)) /
      (Math.log(FREQ_MAX_DAYS) - Math.log(FREQ_MIN_DAYS)),
  );
}

export function computePriority(
  input: PriorityInput,
  options: { valueReference?: number } = {},
): PriorityResult {
  const valueReference = options.valueReference ?? 100000;

  // Paused clients are deliberately out of the running.
  if (input.reminderState === "paused") {
    return { score: 0, level: "none", parts: { timing: 0, value: 0, frequency: 0 } };
  }

  const value = valueScore(input.annualValue, valueReference);
  const frequency = frequencyScore(input.effectiveIntervalDays);

  // Clients on a fixed custom date have a due date but no interval — measure
  // their timing against a nominal monthly cycle so they still rank.
  const timingInterval =
    input.effectiveIntervalDays ?? (input.daysUntilDue != null ? 30 : null);

  // Never-visited clients have no cycle position yet; give them a mid timing
  // score so valuable prospects surface without outranking overdue regulars.
  const timing =
    input.reminderState === "no_history"
      ? 0.4
      : timingScore(input.daysUntilDue, timingInterval);

  const score = Math.round(
    (timing * WEIGHTS.timing + value * WEIGHTS.value + frequency * WEIGHTS.frequency) *
      100,
  );

  const level: PriorityLevel = score >= 60 ? "high" : score >= 35 ? "medium" : "low";
  return { score, level, parts: { timing, value, frequency } };
}

/** Sort helper: highest priority first, ties broken alphabetically. */
export function compareByPriority(
  a: { priorityScore: number; clientName: string },
  b: { priorityScore: number; clientName: string },
): number {
  if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
  return a.clientName.localeCompare(b.clientName);
}
