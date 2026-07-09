// ============================================================================
// Sales-health signals.
//
// Turns a venue's synced Power BI sales history (see src/lib/customer-sync.ts)
// into plain-English "something's up, go and see them" alerts:
//
//   volume_drop      — still ordering, but a lot less than they were.
//   stopped_ordering — gone quiet after a run of regular orders.
//   product_switch   — dropped a product they used to buy regularly, often
//                      alongside picking up a new one in its place (e.g. beef
//                      ravioli → truffle ravioli).
//
// These are signals a rep would otherwise only notice by eyeballing a report.
// Feeding them into the visit suggestions means a venue that quietly halves
// its order, or swaps one line for another, gets a catch-up visit suggested
// even if their normal visit rhythm says they're not due yet.
//
// Pure functions only — no I/O, "today" is injectable — so they're cheap to
// recompute on every calendar load. Nothing derived is ever stored: a resync
// or a threshold tweak is reflected immediately, with nothing to invalidate.
// ============================================================================

import type { SalesHistory, SalesProductPoint } from "../types";
import {
  PRODUCT_DROP_RATIO,
  PRODUCT_MIN_SIGNIFICANT_SALES,
  PRODUCT_SIGNIFICANT_SHARE,
  SALES_DROP_THRESHOLD,
  SALES_STOPPED_MONTHS,
  SALES_WINDOW_MONTHS,
} from "./config";

// "inactive" isn't derived from the sales series here — it's raised in
// suggestions.ts for an existing customer that's gone inactive (3 months, per
// customer-activity.ts) with no reason on record. It lives in this union so it
// flows through the same suggestion reason/chip plumbing as the real sales flags.
export type SalesAlertType = "volume_drop" | "stopped_ordering" | "product_switch" | "inactive";

export interface SalesAlert {
  type: SalesAlertType;
  /** high = clearly worth a visit now; medium = keep an eye on it. */
  severity: "high" | "medium";
  /** Short headline for a badge, e.g. "Ordering down 42%". */
  title: string;
  /** One-sentence explanation for the rep. */
  detail: string;
  /** Signed magnitude where it makes sense (e.g. -0.42 for a 42% fall). */
  metric: number | null;
}

export interface MonthlySales {
  /** First day of the month (local midnight). */
  periodStart: Date;
  sales: number;
  kg: number | null;
}

export interface SalesHealthOptions {
  /** Fractional fall that counts as a volume drop (0.3 = down 30%). */
  dropThreshold?: number;
  /** Consecutive recent zero-order months that count as "stopped". */
  stoppedMonths?: number;
  /** Months either side used to compare "recent" vs "before". */
  windowMonths?: number;
  /** "Now" — injectable for testing. Defaults to current date. */
  today?: Date;
}

const DEFAULTS: Required<Omit<SalesHealthOptions, "today">> = {
  dropThreshold: SALES_DROP_THRESHOLD,
  stoppedMonths: SALES_STOPPED_MONTHS,
  windowMonths: SALES_WINDOW_MONTHS,
};

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

/** Whole months from `b` to `a` (a later than b → positive). */
function monthsBetween(a: Date, b: Date): number {
  return (a.getFullYear() - b.getFullYear()) * 12 + (a.getMonth() - b.getMonth());
}

/**
 * Expand sparse snapshots into a gap-free month-by-month series spanning the
 * OBSERVED range (first → last snapshot month). Interior gaps become genuine
 * zeros. Deliberately stops at the last observed month rather than padding to
 * "today": the current calendar month is usually incomplete, and a venue that
 * has genuinely gone quiet is caught by the staleness check instead — so a
 * part-way-through month is never mistaken for a real fall in orders.
 */
function densify(sales: MonthlySales[]): MonthlySales[] {
  if (sales.length === 0) return [];
  const byMonth = new Map<string, MonthlySales>();
  for (const s of sales) byMonth.set(monthKey(monthStart(s.periodStart)), s);

  const sorted = [...sales].sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime());
  const start = monthStart(sorted[0].periodStart);
  const end = monthStart(sorted[sorted.length - 1].periodStart);

  const out: MonthlySales[] = [];
  for (let m = new Date(start); m <= end; m = addMonths(m, 1)) {
    const hit = byMonth.get(monthKey(m));
    out.push(hit ? { ...hit, periodStart: new Date(m) } : { periodStart: new Date(m), sales: 0, kg: null });
  }
  return out;
}

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function pct(n: number): string {
  return `${Math.round(Math.abs(n) * 100)}%`;
}

/**
 * Detect volume-drop / stopped-ordering alerts from a venue's monthly sales
 * history. Returns the most important issues first; an empty array means
 * "nothing to flag".
 */
export function detectSalesAlerts(sales: MonthlySales[], options: SalesHealthOptions = {}): SalesAlert[] {
  const o = { ...DEFAULTS, ...options };
  const today = monthStart(options.today ?? new Date());
  const series = densify(sales);

  // Need a little history before any signal is trustworthy.
  const monthsWithOrders = series.filter((m) => m.sales > 0).length;
  if (series.length < 3 || monthsWithOrders < 2) return [];

  const alerts: SalesAlert[] = [];

  // ---- Stopped ordering ----------------------------------------------------
  // How long since their last month with any orders? Measured against
  // "today", so a venue whose sales simply vanish from the feed is caught
  // even though their observed history just stops.
  const lastOrder = [...series].reverse().find((m) => m.sales > 0) ?? null;
  const quietMonths = lastOrder ? monthsBetween(today, monthStart(lastOrder.periodStart)) : 0;

  let stopped = false;
  if (lastOrder && quietMonths >= o.stoppedMonths) {
    stopped = true;
    alerts.push({
      type: "stopped_ordering",
      severity: quietMonths >= o.stoppedMonths + 1 ? "high" : "medium",
      title: `No orders in ${quietMonths} month${quietMonths === 1 ? "" : "s"}`,
      detail: `They used to order regularly but haven't for ${quietMonths} month${
        quietMonths === 1 ? "" : "s"
      } — worth a visit to find out what changed.`,
      metric: -1,
    });
  }

  // ---- Volume drop ----------------------------------------------------------
  // Compare the most recent window against the window before it. Skip when
  // they've stopped entirely (that's already the stronger "stopped" signal).
  if (!stopped && series.length >= o.windowMonths * 2) {
    const recent = series.slice(-o.windowMonths);
    const prior = series.slice(-o.windowMonths * 2, -o.windowMonths);
    const recentAvg = avg(recent.map((m) => m.sales));
    const priorAvg = avg(prior.map((m) => m.sales));

    if (priorAvg > 0) {
      const change = (recentAvg - priorAvg) / priorAvg; // negative = fell
      if (change <= -o.dropThreshold) {
        alerts.push({
          type: "volume_drop",
          severity: change <= -0.5 ? "high" : "medium",
          title: `Ordering down ${pct(change)}`,
          detail: `Their recent orders are down ${pct(
            change,
          )} on the previous few months — a good moment to check in and understand why.`,
          metric: change,
        });
      }
    }
  }

  const rank = { high: 0, medium: 1 } as const;
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/**
 * Detect a per-product substitution: a venue that's dropped a product it used
 * to order regularly, often alongside picking up a new one in its place. This
 * only needs two comparison windows (not a monthly series), and is
 * deliberately one-sided — gaining a new product with no corresponding drop
 * isn't flagged, since that's just growth, not a reason to check in.
 */
export function detectProductSwitchAlerts(
  priorProducts: SalesProductPoint[],
  recentProducts: SalesProductPoint[],
  options: { significantShare?: number; minSignificantSales?: number; dropRatio?: number } = {},
): SalesAlert[] {
  const significantShare = options.significantShare ?? PRODUCT_SIGNIFICANT_SHARE;
  const minSignificantSales = options.minSignificantSales ?? PRODUCT_MIN_SIGNIFICANT_SALES;
  const dropRatio = options.dropRatio ?? PRODUCT_DROP_RATIO;

  const priorTotal = priorProducts.reduce((s, p) => s + p.sales, 0);
  const recentTotal = recentProducts.reduce((s, p) => s + p.sales, 0);
  // Fully quiet in both windows is stopped_ordering's job, not this one's.
  if (priorTotal <= 0 || recentTotal <= 0) return [];

  const recentByCode = new Map(recentProducts.map((p) => [p.code, p]));
  const priorByCode = new Map(priorProducts.map((p) => [p.code, p]));

  // The clearest dropped product: was a meaningful part of their order
  // before, has now collapsed to a fraction of that.
  let dropped: SalesProductPoint | null = null;
  let droppedShare = 0;
  for (const p of priorProducts) {
    const share = p.sales / priorTotal;
    if (share < significantShare || p.sales < minSignificantSales) continue;
    const recentSales = recentByCode.get(p.code)?.sales ?? 0;
    if (recentSales > p.sales * dropRatio) continue; // still buying enough of it
    if (share > droppedShare) {
      dropped = p;
      droppedShare = share;
    }
  }
  if (!dropped) return [];

  // A newcomer that wasn't meaningful before and now is — the likely
  // replacement, if there is one.
  let surged: SalesProductPoint | null = null;
  let surgedShare = 0;
  for (const p of recentProducts) {
    if (p.code === dropped.code) continue;
    const recentShare = p.sales / recentTotal;
    if (recentShare < significantShare) continue;
    const priorSales = priorByCode.get(p.code)?.sales ?? 0;
    const priorShare = priorTotal > 0 ? priorSales / priorTotal : 0;
    if (priorShare >= significantShare / 2) continue; // already a normal part of their order
    if (recentShare > surgedShare) {
      surged = p;
      surgedShare = recentShare;
    }
  }

  const title = surged ? `Switched off ${dropped.description}` : `Stopped ordering ${dropped.description}`;
  const detail = surged
    ? `They've dropped ${dropped.description} (${pct(droppedShare)} of their order) and picked up ${
        surged.description
      } instead — worth a visit to see why, and whether the rest of the range still fits.`
    : `${dropped.description} used to be ${pct(
        droppedShare,
      )} of their order and has now dropped off — worth asking whether they've switched supplier for it.`;

  return [
    {
      type: "product_switch",
      severity: droppedShare >= significantShare * 2 ? "high" : "medium",
      title,
      detail,
      metric: -droppedShare,
    },
  ];
}

function monthStringToDate(month: string): Date {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, (m || 1) - 1, 1);
}

/**
 * Runs every detector against a venue's synced sales-history snapshot and
 * returns one ranked list. Empty when there's no snapshot at all (unsynced or
 * non-customer venues) — callers can treat that as simply "no alerts".
 */
export function detectAllSalesAlerts(history: SalesHistory | undefined, today: Date = new Date()): SalesAlert[] {
  if (!history) return [];
  const monthly: MonthlySales[] = history.monthly.map((m) => ({
    periodStart: monthStringToDate(m.month),
    sales: m.sales,
    kg: m.kg,
  }));
  const alerts = [
    ...detectSalesAlerts(monthly, { today }),
    ...detectProductSwitchAlerts(history.priorProducts, history.recentProducts),
  ];
  const rank = { high: 0, medium: 1 } as const;
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
