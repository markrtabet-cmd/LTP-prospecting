// Order-cadence classification — the single source of truth for "this customer
// has broken their ordering pattern", shared by the calendar's "gone quiet"
// suggestions (src/lib/visits/sales-health.ts, via each customer's synced
// orderDates) and the insights "customers requiring attention" report (server,
// via order dates pulled fresh from Power BI). Same input shape (a list of order
// dates), same rules, so the two can never drift.
//
// The rules (from the brief):
//   orders daily / twice-weekly   → flag if no order in 1 week
//   orders weekly                 → flag if no order in 2 weeks
//   orders fortnightly            → flag if no order in 3 weeks
//   orders every 3 weeks          → flag if no order in 1 month
//   orders monthly                → flag if no order in 6 weeks
//   orders every 2 months         → flag if no order in 3 months
// A customer's "typical gap" is the median gap between consecutive order days;
// it's bucketed into the nearest tier, then compared against days-since-last.

export interface CadenceTier {
  /** Upper bound (inclusive) on the typical gap in days for this tier. */
  maxGapDays: number;
  /** Days without an order that count as "attention needed" for this tier. */
  overdueDays: number;
  label: string;
}

// Ordered fastest → slowest; the first tier whose maxGapDays covers the typical
// gap wins. Anything slower than the last tier is left to the 3-month inactivity
// rule (see customer-activity.ts) rather than flagged here.
export const CADENCE_TIERS: CadenceTier[] = [
  { maxGapDays: 4, overdueDays: 7, label: "Daily / twice-weekly" },
  { maxGapDays: 9, overdueDays: 14, label: "Weekly" },
  { maxGapDays: 16, overdueDays: 21, label: "Fortnightly" },
  { maxGapDays: 24, overdueDays: 30, label: "Every 3 weeks" },
  { maxGapDays: 45, overdueDays: 42, label: "Monthly" },
  { maxGapDays: 75, overdueDays: 90, label: "Every 2 months" },
];

export interface CadenceVerdict {
  /** Overdue against their own established pattern. */
  attention: boolean;
  /** The matched cadence tier's label, or null when it can't be classified. */
  tierLabel: string | null;
  typicalGapDays: number | null;
  daysSinceLast: number | null;
  overdueThresholdDays: number | null;
}

const NONE: CadenceVerdict = {
  attention: false,
  tierLabel: null,
  typicalGapDays: null,
  daysSinceLast: null,
  overdueThresholdDays: null,
};

function toDayNumber(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? NaN : Math.floor(t / 86_400_000);
}

/**
 * Classify a customer's ordering cadence from their order dates (any ISO/date
 * strings; deduped to whole days). Needs at least 3 distinct order days to
 * estimate a cadence. Returns attention=false when it can't classify or the
 * customer is within their normal rhythm.
 */
export function classifyCadence(orderDates: string[] | undefined | null, today: Date = new Date()): CadenceVerdict {
  if (!orderDates || orderDates.length < 3) return NONE;
  const days = Array.from(new Set(orderDates.map(toDayNumber).filter((d) => !Number.isNaN(d)))).sort((a, b) => a - b);
  if (days.length < 3) return NONE;

  const gaps: number[] = [];
  for (let i = 1; i < days.length; i++) gaps.push(days[i] - days[i - 1]);
  gaps.sort((a, b) => a - b);
  const typicalGap = gaps[Math.floor(gaps.length / 2)]; // median gap

  const todayDay = Math.floor(today.getTime() / 86_400_000);
  const daysSinceLast = todayDay - days[days.length - 1];

  const tier = CADENCE_TIERS.find((t) => typicalGap <= t.maxGapDays);
  if (!tier) {
    return { attention: false, tierLabel: null, typicalGapDays: typicalGap, daysSinceLast, overdueThresholdDays: null };
  }
  return {
    attention: daysSinceLast >= tier.overdueDays,
    tierLabel: tier.label,
    typicalGapDays: typicalGap,
    daysSinceLast,
    overdueThresholdDays: tier.overdueDays,
  };
}
