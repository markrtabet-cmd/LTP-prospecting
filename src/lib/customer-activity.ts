// Customer "active vs inactive" — used by the Existing customers list (to hide
// dormant accounts) and the profile (to show/override the status).
//
// Active = ordered recently. Recency comes from the nightly Power BI sales
// snapshot (Restaurant.salesHistory.monthly: yyyy-MM + sales). A manual override
// (Restaurant.customerActive) always wins so a rep can keep a seasonal account
// visible or park one that's gone quiet.

import type { Restaurant } from "./types";

// Active = ordered within the last this-many calendar months (this month or the
// preceding two, for 3). A customer whose most recent order is this many or more
// whole months in the past has "not ordered in the last N months" → inactive.
export const INACTIVE_AFTER_MONTHS = 3;

/** yyyy-MM of the most recent month this customer had sales > 0, or null when
 * there's no synced sales history to judge from. */
export function lastOrderMonth(r: Restaurant): string | null {
  const monthly = r.salesHistory?.monthly;
  if (!monthly?.length) return null;
  let latest: string | null = null;
  for (const m of monthly) {
    // yyyy-MM is zero-padded, so lexical comparison is chronological.
    if (m.sales > 0 && (latest === null || m.month > latest)) latest = m.month;
  }
  return latest;
}

/** Whole calendar months from yyyy-MM `month` up to `now` (0 = this month). */
function monthsSince(month: string, now: Date): number {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return Number.POSITIVE_INFINITY;
  return (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m);
}

export type ActivitySource = "manual" | "recency" | "unknown";

export interface CustomerActivity {
  active: boolean;
  /** How we decided: a manual override, sales recency, or no data to judge. */
  source: ActivitySource;
  /** Most recent order month (yyyy-MM), when known. */
  lastOrderMonth: string | null;
}

/** Full activity verdict with the reasoning, for the profile UI. */
export function customerActivity(r: Restaurant, now: Date = new Date()): CustomerActivity {
  const last = lastOrderMonth(r);
  if (typeof r.customerActive === "boolean") {
    return { active: r.customerActive, source: "manual", lastOrderMonth: last };
  }
  // No synced sales history at all → we can't judge, so keep them visible rather
  // than hide a customer whose data simply hasn't synced yet. (The nightly sync
  // attaches a salesHistory — possibly with an empty `monthly` — to every matched
  // customer, so a *present* history with no recent orders is genuinely inactive,
  // not unknown.)
  if (!r.salesHistory) {
    return { active: true, source: "unknown", lastOrderMonth: null };
  }
  // We have a sales window: active iff their most recent order is recent enough.
  // An empty/old window (last === null, or last too long ago) is inactive.
  const active = last !== null && monthsSince(last, now) < INACTIVE_AFTER_MONTHS;
  return { active, source: "recency", lastOrderMonth: last };
}

/** Convenience boolean for list filtering. */
export function isCustomerActive(r: Restaurant, now: Date = new Date()): boolean {
  return customerActivity(r, now).active;
}

/**
 * Proxy for "became a customer in the last ~30 days". No acquisition date is
 * synced, so use the earliest month with sales in the Power BI history as the
 * start date. Approximate, and only as good as the synced history window.
 * Shared by the dashboard KPI and the Customers page's "new" filter.
 */
export function isNewCustomer30d(r: Restaurant, now: Date = new Date()): boolean {
  const months = r.salesHistory?.monthly;
  if (!months || months.length === 0) return false;
  let earliest: string | null = null;
  for (const m of months) {
    if (m.sales > 0 && (earliest === null || m.month < earliest)) earliest = m.month;
  }
  if (!earliest) return false;
  const [y, mo] = earliest.split("-").map(Number);
  if (!y || !mo) return false;
  const daysSince = (now.getTime() - new Date(y, mo - 1, 1).getTime()) / 86_400_000;
  return daysSince <= 35;
}
