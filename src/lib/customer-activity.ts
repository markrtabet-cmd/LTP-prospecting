// Customer "active vs inactive" — used by the Existing customers list (to hide
// dormant accounts) and the profile (to show the status).
//
// Active = ordered recently. Recency comes from the Power BI sales snapshot
// (Restaurant.salesHistory.monthly: yyyy-MM + sales). It is fully automatic: a
// customer is inactive after INACTIVE_AFTER_MONTHS whole months with no order,
// and becomes active again the moment they order. There is no manual override —
// the only way back to active is a fresh order (see the deprecated
// Restaurant.customerActive).

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

export type ActivitySource = "status" | "recency" | "unknown";

export interface CustomerActivity {
  active: boolean;
  /** How we decided: Power BI account status, sales recency, or no data. */
  source: ActivitySource;
  /** Most recent order month (yyyy-MM), when known. */
  lastOrderMonth: string | null;
}

/** The Power BI account status (F_DAILY[Account Status]) as a real value, or ""
 * when there is none to judge from. "-" is Power BI's placeholder for blank. */
function accountStatusValue(r: Restaurant): string {
  const s = (r.accountStatus ?? "").trim();
  return !s || s === "-" ? "" : s;
}

/** Whether an account-status value counts as active. Power BI uses "Active";
 * anything else present ("Closed", "On Stop", …) means inactive. */
function isActiveStatus(status: string): boolean {
  return status.trim().toLowerCase() === "active";
}

/** Full activity verdict with the reasoning, for the profile UI. */
export function customerActivity(r: Restaurant, now: Date = new Date()): CustomerActivity {
  const last = lastOrderMonth(r);
  // 1) Power BI's account status is AUTHORITATIVE when present — it replaces the
  //    sales-recency rule (per the spec's "new place on Power BI which shows if a
  //    customer is inactive"). A business marked "Active" stays active even if
  //    orders have paused; one marked "Closed" / "On Stop" is inactive at once.
  //    (The pattern-based "they've gone quiet" nudge still fires separately via
  //    the calendar's cadence check — see src/lib/visits/suggestions.ts.)
  const status = accountStatusValue(r);
  if (status) {
    return { active: isActiveStatus(status), source: "status", lastOrderMonth: last };
  }
  // 2) No status on record → fall back to sales recency (the original rule). No
  //    synced sales history at all → we can't judge, so keep them visible rather
  //    than hide a customer whose data simply hasn't synced yet. (The nightly
  //    sync attaches a salesHistory — possibly with an empty `monthly` — to every
  //    matched customer, so a *present* history with no recent orders is
  //    genuinely inactive, not unknown.)
  if (!r.salesHistory) {
    return { active: true, source: "unknown", lastOrderMonth: null };
  }
  // We have a sales window: active iff their most recent order is recent enough.
  // An empty/old window (last === null, or last too long ago) is inactive.
  const active = last !== null && monthsSince(last, now) < INACTIVE_AFTER_MONTHS;
  return { active, source: "recency", lastOrderMonth: last };
}

/** The Power BI account-status label for display ("On Stop", "Closed"), or null
 * when the account is active / has no status. Distinct from inactivityReason():
 * the status is a coarse category, not necessarily the recorded *reason* — an
 * "On Stop" customer with no reason on record still flags for a chase. */
export function accountStatusLabel(r: Restaurant): string | null {
  const status = accountStatusValue(r);
  return status && !isActiveStatus(status) ? status : null;
}

/** A permanently-closed account (Power BI status "Closed", or a recorded reason
 * that says so). Closed accounts are inactive but NOT worth a "find out why"
 * visit — the calendar leaves them alone rather than nagging. */
export function isClosedAccount(r: Restaurant): boolean {
  if (accountStatusValue(r).toLowerCase() === "closed") return true;
  const reason = (r.inactivityReason ?? "").toLowerCase();
  const mgr = (r.customerAccountManager ?? "").toLowerCase();
  return reason.includes("closed") || mgr === "closed";
}

/** A customer who is inactive with NO reason on record and isn't simply closed —
 * the population the calendar nudges the rep to chase (and offers to email
 * customer services about). "Reason on record" = the dedicated Power BI reason
 * (inactivityReason), NOT the coarse account status: an "On Stop" account with
 * no stated reason is exactly what we want the rep to investigate. */
export function inactiveNeedsReason(r: Restaurant, now: Date = new Date()): boolean {
  if (isCustomerActive(r, now)) return false;
  if (isClosedAccount(r)) return false;
  return !inactivityReason(r);
}

/** Convenience boolean for list filtering. */
export function isCustomerActive(r: Restaurant, now: Date = new Date()): boolean {
  return customerActivity(r, now).active;
}

/**
 * The stated reason a customer is inactive, or null when none is on record.
 * Prefers the reason synced from Power BI (Restaurant.inactivityReason, wired via
 * POWERBI_INACTIVITY_REASON_COLUMN), and falls back to the coarse
 * CLOSED / INACTIVE / DUPLICATE status Power BI parks in the account-manager
 * field for dead accounts (mirrors accountStatus() in src/components/RepCell.tsx).
 * When this returns null the calendar keeps nudging the rep to schedule a meeting
 * and find out why — see src/lib/visits/suggestions.ts.
 */
export function inactivityReason(r: Restaurant): string | null {
  const explicit = (r.inactivityReason ?? "").trim();
  if (explicit) return explicit;
  const mgr = (r.customerAccountManager ?? "").trim().toUpperCase();
  if (mgr === "CLOSED") return "Closed";
  if (mgr === "INACTIVE") return "Inactive";
  if (mgr === "DOUBLE") return "Duplicate";
  return null;
}

/** Whole calendar months from yyyy-MM `a` to yyyy-MM `b` (b later → positive). */
function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  if (!ay || !am || !by || !bm) return 0;
  return (by - ay) * 12 + (bm - am);
}

/** The months (yyyy-MM, ascending) in which this customer had sales > 0. */
function orderedMonths(r: Restaurant): string[] {
  const months = r.salesHistory?.monthly;
  if (!months?.length) return [];
  return months.filter((m) => m.sales > 0).map((m) => m.month).sort();
}

/**
 * Proxy for "became a customer in the last ~30 days". No acquisition date is
 * synced, so use the earliest month with sales in the Power BI history as the
 * start date. Approximate, and only as good as the synced history window.
 */
export function isFirstTimeCustomer30d(r: Restaurant, now: Date = new Date()): boolean {
  const ordered = orderedMonths(r);
  const earliest = ordered[0];
  if (!earliest) return false;
  const [y, mo] = earliest.split("-").map(Number);
  if (!y || !mo) return false;
  const daysSince = (now.getTime() - new Date(y, mo - 1, 1).getTime()) / 86_400_000;
  return daysSince <= 35;
}

/**
 * A REACTIVATION: a returning customer who ordered again this month after a gap
 * of INACTIVE_AFTER_MONTHS (3) or more whole months with no orders. Their two
 * most recent order months are >= 3 months apart AND the latest is the current
 * calendar month (so it's a fresh "just came back", not an old gap deep in the
 * synced window). Only observable within the synced history window (~8 months).
 */
export function isReactivatedCustomer(r: Restaurant, now: Date = new Date()): boolean {
  const ordered = orderedMonths(r);
  if (ordered.length < 2) return false;
  const latest = ordered[ordered.length - 1];
  const prev = ordered[ordered.length - 2];
  // The comeback order must be recent (this calendar month).
  if (monthsSince(latest, now) !== 0) return false;
  return monthsBetween(prev, latest) >= INACTIVE_AFTER_MONTHS;
}

/**
 * "New" customer for the KPI / Customers filter / Insights card: EITHER a
 * genuinely-new customer acquired in the last ~30 days, OR a returning customer
 * who reactivated this month after 3+ months of inactivity. Shared everywhere
 * "new customers" is surfaced so the broadened meaning is consistent.
 */
export function isNewCustomer30d(r: Restaurant, now: Date = new Date()): boolean {
  return isFirstTimeCustomer30d(r, now) || isReactivatedCustomer(r, now);
}
