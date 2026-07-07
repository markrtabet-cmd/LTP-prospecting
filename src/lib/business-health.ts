// ============================================================================
// Weekly business-health signals — the computed inputs behind the Dashboard's
// two AI summaries ("what looks off" / "state of the business").
//
// Deliberately narrower than a full BI suite: covers the signals that are
// reliably computable from what Power BI actually exposes (order history,
// cost, category, channel) and skips ones that would need data this dataset
// doesn't have (payment due/paid dates, a list-price reference, return codes).
// See business-health-data.ts for where the raw rows come from; this file is
// pure — no I/O — so it's easy to test and safe to recompute every week.
// ============================================================================

export interface CustomerMeta {
  custCode: string;
  name: string;
  salesRep: string | null;
  channel: string | null;
  customerGroup: string | null;
  route: string | null;
  firstSaleDate: string | null;
}

export interface CustomerMonthPoint {
  custCode: string;
  year: number;
  month: number;
  sales: number;
  cost: number;
  orders: number;
}

export interface OrderFrequencyRow {
  custCode: string;
  name: string;
  status: string;
  orderFrequencyDays: number | null;
  daysOverExpected: number | null;
  expectedOrderValue: number | null;
}

export interface CategoryWindowPoint {
  custCode: string;
  category: string;
  window: "recent" | "prior";
  sales: number;
}

export interface ChannelMonthPoint {
  channel: string;
  year: number;
  month: number;
  sales: number;
}

export type AnomalyType = "order_frequency_drop" | "basket_shrinkage" | "product_mix_shift" | "vanished_new_account";

export interface AnomalySignal {
  type: AnomalyType;
  severity: "high" | "medium";
  custCode: string;
  customerName: string;
  salesRep: string | null;
  headline: string;
  detail: string;
  metric: number | null;
}

export type OpportunityType = "revenue_concentration" | "reorder_due" | "win_back" | "channel_trend" | "margin_outlier";

export interface OpportunitySignal {
  type: OpportunityType;
  customerName?: string;
  /** Power BI account manager for this customer, when the signal is per-account
   * (null for company-wide signals). Lets the dashboard scope a rep's insights
   * to their own accounts. */
  salesRep?: string | null;
  headline: string;
  detail: string;
  metric?: number | null;
}

function monthKey(y: number, m: number): number {
  return y * 12 + m;
}

function byCustomer<T extends { custCode: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const arr = map.get(r.custCode) ?? [];
    arr.push(r);
    map.set(r.custCode, arr);
  }
  return map;
}

function pct(n: number): string {
  return `${Math.round(Math.abs(n) * 100)}%`;
}

// ---- Anomalies (Summary 1) --------------------------------------------------

/**
 * Order frequency drop — Power BI's own v_OrderFrequency already tracks each
 * active account's usual cadence and how many days past its expected order
 * date it now is. This is the single strongest "quietly lapsing" signal: a
 * chef who's drifting to another supplier rarely announces it.
 */
export function detectOrderFrequencyDrops(rows: OrderFrequencyRow[], metaByCode: Map<string, CustomerMeta>): AnomalySignal[] {
  const out: AnomalySignal[] = [];
  for (const r of rows) {
    if (r.status !== "Active" || r.daysOverExpected == null || r.daysOverExpected <= 0 || !r.orderFrequencyDays) continue;
    const daysSince = r.orderFrequencyDays + r.daysOverExpected;
    out.push({
      type: "order_frequency_drop",
      severity: r.daysOverExpected > r.orderFrequencyDays ? "high" : "medium",
      custCode: r.custCode,
      customerName: r.name,
      salesRep: metaByCode.get(r.custCode)?.salesRep ?? null,
      headline: `${r.name} usually orders every ${r.orderFrequencyDays} days — it's been ${daysSince}.`,
      detail: `${r.daysOverExpected} day${r.daysOverExpected === 1 ? "" : "s"} past their expected order date${
        r.expectedOrderValue ? `, worth roughly £${Math.round(r.expectedOrderValue)} per order` : ""
      } — worth a call before they lapse fully.`,
      metric: r.daysOverExpected,
    });
  }
  return out.sort((a, b) => (b.metric ?? 0) - (a.metric ?? 0));
}

/**
 * Basket shrinkage — still ordering on roughly the same cadence, but the
 * recent 3-month average is down 30%+ on the 3 months before. Often means
 * you've quietly lost part of the menu to a competitor while keeping the rest.
 */
export function detectBasketShrinkage(
  monthly: CustomerMonthPoint[],
  metaByCode: Map<string, CustomerMeta>,
  options: { dropThreshold?: number; windowMonths?: number } = {},
): AnomalySignal[] {
  const dropThreshold = options.dropThreshold ?? 0.3;
  const windowMonths = options.windowMonths ?? 3;
  const out: AnomalySignal[] = [];

  byCustomer(monthly).forEach((points, custCode) => {
    const sorted = [...points].sort((a, b) => monthKey(a.year, a.month) - monthKey(b.year, b.month));
    if (sorted.length < windowMonths * 2) return;
    const recent = sorted.slice(-windowMonths);
    const prior = sorted.slice(-windowMonths * 2, -windowMonths);
    const recentAvg = recent.reduce((s, p) => s + p.sales, 0) / windowMonths;
    const priorAvg = prior.reduce((s, p) => s + p.sales, 0) / windowMonths;
    if (priorAvg <= 0 || recentAvg <= 0) return; // a full stop is order_frequency_drop's job
    const change = (recentAvg - priorAvg) / priorAvg;
    if (change > -dropThreshold) return;

    const meta = metaByCode.get(custCode);
    out.push({
      type: "basket_shrinkage",
      severity: change <= -0.5 ? "high" : "medium",
      custCode,
      customerName: meta?.name ?? custCode,
      salesRep: meta?.salesRep ?? null,
      headline: `${meta?.name ?? custCode} is still ordering, but down ${pct(change)} on the previous few months.`,
      detail: `Recent average ~£${Math.round(recentAvg)}/month vs ~£${Math.round(priorAvg)}/month before — check whether part of the order has moved elsewhere.`,
      metric: change,
    });
  });
  return out.sort((a, b) => (a.metric ?? 0) - (b.metric ?? 0));
}

/**
 * Product-mix shift — a customer drops a category they used to buy
 * regularly. Early sign of a menu change or a competitor winning one line,
 * even when their overall spend looks fine.
 */
export function detectProductMixShifts(
  categoryWindows: CategoryWindowPoint[],
  metaByCode: Map<string, CustomerMeta>,
  options: { significantShare?: number; dropRatio?: number } = {},
): AnomalySignal[] {
  const significantShare = options.significantShare ?? 0.2;
  const dropRatio = options.dropRatio ?? 0.25;
  const byCust = new Map<string, { recent: CategoryWindowPoint[]; prior: CategoryWindowPoint[] }>();
  for (const row of categoryWindows) {
    const entry = byCust.get(row.custCode) ?? { recent: [], prior: [] };
    entry[row.window].push(row);
    byCust.set(row.custCode, entry);
  }

  const out: AnomalySignal[] = [];
  byCust.forEach(({ recent, prior }, custCode) => {
    const priorTotal = prior.reduce((s, p) => s + p.sales, 0);
    const recentTotal = recent.reduce((s, p) => s + p.sales, 0);
    if (priorTotal <= 0 || recentTotal <= 0) return;

    const recentByCategory = new Map(recent.map((p) => [p.category, p.sales]));
    let dropped: { category: string; share: number } | null = null;
    for (const p of prior) {
      const share = p.sales / priorTotal;
      if (share < significantShare) continue;
      const nowSales = recentByCategory.get(p.category) ?? 0;
      if (nowSales > p.sales * dropRatio) continue;
      if (!dropped || share > dropped.share) dropped = { category: p.category, share };
    }
    if (!dropped) return;

    const meta = metaByCode.get(custCode);
    out.push({
      type: "product_mix_shift",
      severity: dropped.share >= significantShare * 2 ? "high" : "medium",
      custCode,
      customerName: meta?.name ?? custCode,
      salesRep: meta?.salesRep ?? null,
      headline: `${meta?.name ?? custCode} has stopped ordering ${dropped.category}.`,
      detail: `${dropped.category} used to be ${pct(dropped.share)} of their order and has now dropped off — worth asking if they've switched supplier for that line.`,
      metric: -dropped.share,
    });
  });
  return out.sort((a, b) => (a.metric ?? 0) - (b.metric ?? 0));
}

/**
 * New account ordered once (or a couple of times) and vanished — an
 * onboarding failure that's cheap to fix if caught in week two, expensive to
 * notice if it's caught in month six.
 */
export function detectVanishedNewAccounts(
  monthly: CustomerMonthPoint[],
  metaByCode: Map<string, CustomerMeta>,
  today: Date,
): AnomalySignal[] {
  const out: AnomalySignal[] = [];
  byCustomer(monthly).forEach((points, custCode) => {
    const meta = metaByCode.get(custCode);
    if (!meta?.firstSaleDate) return;
    const firstSale = new Date(meta.firstSaleDate);
    const daysSinceFirst = Math.round((today.getTime() - firstSale.getTime()) / 86_400_000);
    if (daysSinceFirst < 21 || daysSinceFirst > 120) return; // only a "just realised" window
    const monthsWithOrders = points.filter((p) => p.sales > 0).length;
    const lastOrderMonth = [...points].sort((a, b) => monthKey(b.year, b.month) - monthKey(a.year, a.month))[0];
    const monthsSinceLast = lastOrderMonth
      ? monthKey(today.getFullYear(), today.getMonth() + 1) - monthKey(lastOrderMonth.year, lastOrderMonth.month)
      : 99;
    if (monthsWithOrders > 2 || monthsSinceLast < 2) return;

    out.push({
      type: "vanished_new_account",
      severity: "high",
      custCode,
      customerName: meta.name,
      salesRep: meta.salesRep,
      headline: `${meta.name} ordered ${monthsWithOrders === 1 ? "once" : "a couple of times"} after signing up, then went quiet.`,
      detail: `First order ${daysSinceFirst} days ago, nothing in the last ${monthsSinceLast} month${monthsSinceLast === 1 ? "" : "s"} — an onboarding check-in now is cheap; waiting isn't.`,
      metric: monthsSinceLast,
    });
  });
  return out;
}

// ---- Opportunities (Summary 2) ---------------------------------------------

/** % of total revenue from the top 10 accounts — the classic wholesale
 * concentration-risk metric. */
export function computeRevenueConcentration(monthly: CustomerMonthPoint[], metaByCode: Map<string, CustomerMeta>): OpportunitySignal {
  const totalByCustomer = new Map<string, number>();
  for (const p of monthly) totalByCustomer.set(p.custCode, (totalByCustomer.get(p.custCode) ?? 0) + p.sales);
  const ranked = Array.from(totalByCustomer.entries()).sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((s, [, v]) => s + v, 0);
  const top10 = ranked.slice(0, 10).reduce((s, [, v]) => s + v, 0);
  const share = total > 0 ? top10 / total : 0;
  const names = ranked.slice(0, 3).map(([code]) => metaByCode.get(code)?.name ?? code);
  return {
    type: "revenue_concentration",
    headline: `Top 10 accounts are ${pct(share)} of revenue over the period.`,
    detail: `Led by ${names.join(", ")}. ${share > 0.4 ? "High concentration — losing any one of these would hurt." : "Reasonably spread."}`,
    metric: share,
  };
}

/** Who's statistically due to order this week and hasn't — turns the summary
 * into a proactive call sheet, not just a report. */
export function buildReorderDueList(rows: OrderFrequencyRow[], metaByCode: Map<string, CustomerMeta>, limit = 8): OpportunitySignal[] {
  return rows
    .filter((r) => r.status === "Active" && r.daysOverExpected != null && r.daysOverExpected >= 0)
    .sort((a, b) => (b.daysOverExpected ?? 0) - (a.daysOverExpected ?? 0))
    .slice(0, limit)
    .map((r) => ({
      type: "reorder_due" as const,
      customerName: r.name,
      salesRep: metaByCode.get(r.custCode)?.salesRep ?? null,
      headline: `${r.name} is due${r.daysOverExpected! > 0 ? ` (${r.daysOverExpected} days over)` : " today"}.`,
      detail: `Usually every ${r.orderFrequencyDays ?? "?"} days, rep ${metaByCode.get(r.custCode)?.salesRep ?? "unassigned"}.`,
      metric: r.daysOverExpected,
    }));
}

/** Lapsed accounts, ranked by what they used to be worth — chase the
 * worthwhile ones first, not just the most recently quiet. */
export function rankWinBackCandidates(
  monthly: CustomerMonthPoint[],
  metaByCode: Map<string, CustomerMeta>,
  today: Date,
  limit = 8,
): OpportunitySignal[] {
  const byCust = byCustomer(monthly);
  const candidates: { custCode: string; annualisedValue: number; monthsSinceLast: number }[] = [];
  byCust.forEach((points, custCode) => {
    const sorted = [...points].sort((a, b) => monthKey(a.year, a.month) - monthKey(b.year, b.month));
    const lastOrder = [...sorted].reverse().find((p) => p.sales > 0);
    if (!lastOrder) return;
    const monthsSinceLast = monthKey(today.getFullYear(), today.getMonth() + 1) - monthKey(lastOrder.year, lastOrder.month);
    if (monthsSinceLast < 3) return; // still active enough not to count as lapsed
    const activeMonths = sorted.filter((p) => p.sales > 0);
    const annualisedValue = activeMonths.length ? (activeMonths.reduce((s, p) => s + p.sales, 0) / activeMonths.length) * 12 : 0;
    if (annualisedValue <= 0) return;
    candidates.push({ custCode, annualisedValue, monthsSinceLast });
  });
  return candidates
    .sort((a, b) => b.annualisedValue - a.annualisedValue)
    .slice(0, limit)
    .map((c) => {
      const meta = metaByCode.get(c.custCode);
      return {
        type: "win_back" as const,
        customerName: meta?.name ?? c.custCode,
        salesRep: meta?.salesRep ?? null,
        headline: `${meta?.name ?? c.custCode} — was worth ~£${Math.round(c.annualisedValue).toLocaleString()}/year, quiet for ${c.monthsSinceLast} months.`,
        detail: `Rep ${meta?.salesRep ?? "unassigned"}.`,
        metric: c.annualisedValue,
      };
    });
}

/** Wholesale vs B2C vs retail (or whatever channel taxonomy Power BI uses) —
 * trend per channel, to see where to push next quarter. */
export function computeChannelTrend(channelMonthly: ChannelMonthPoint[], windowMonths = 3): OpportunitySignal[] {
  const byChannel = new Map<string, ChannelMonthPoint[]>();
  for (const p of channelMonthly) {
    const arr = byChannel.get(p.channel) ?? [];
    arr.push(p);
    byChannel.set(p.channel, arr);
  }
  const out: OpportunitySignal[] = [];
  byChannel.forEach((points, channel) => {
    const sorted = [...points].sort((a, b) => monthKey(a.year, a.month) - monthKey(b.year, b.month));
    if (sorted.length < windowMonths * 2) return;
    const recent = sorted.slice(-windowMonths).reduce((s, p) => s + p.sales, 0) / windowMonths;
    const prior = sorted.slice(-windowMonths * 2, -windowMonths).reduce((s, p) => s + p.sales, 0) / windowMonths;
    if (prior <= 0) return;
    const change = (recent - prior) / prior;
    out.push({
      type: "channel_trend",
      headline: `${channel}: ${change >= 0 ? "up" : "down"} ${pct(change)} vs the previous ${windowMonths} months.`,
      detail: `~£${Math.round(recent).toLocaleString()}/month recently.`,
      metric: change,
    });
  });
  return out.sort((a, b) => Math.abs(b.metric ?? 0) - Math.abs(a.metric ?? 0));
}

/** High-revenue accounts with thin margin — flags who you're over-servicing
 * relative to what they actually earn you. */
export function detectMarginOutliers(
  monthly: CustomerMonthPoint[],
  metaByCode: Map<string, CustomerMeta>,
  options: { minRevenue?: number; thinMarginBelow?: number; limit?: number } = {},
): OpportunitySignal[] {
  const minRevenue = options.minRevenue ?? 1000;
  const thinMarginBelow = options.thinMarginBelow ?? 0.25;
  const limit = options.limit ?? 6;
  const totals = new Map<string, { sales: number; cost: number }>();
  for (const p of monthly) {
    const t = totals.get(p.custCode) ?? { sales: 0, cost: 0 };
    t.sales += p.sales;
    t.cost += p.cost;
    totals.set(p.custCode, t);
  }
  const flagged: { custCode: string; sales: number; margin: number }[] = [];
  totals.forEach((t, custCode) => {
    if (t.sales < minRevenue) return;
    const margin = t.sales > 0 ? (t.sales - t.cost) / t.sales : 0;
    if (margin < thinMarginBelow) flagged.push({ custCode, sales: t.sales, margin });
  });
  return flagged
    .sort((a, b) => b.sales - a.sales)
    .slice(0, limit)
    .map(({ custCode, sales, margin }) => {
      const meta = metaByCode.get(custCode);
      return {
        type: "margin_outlier" as const,
        customerName: meta?.name ?? custCode,
        salesRep: meta?.salesRep ?? null,
        headline: `${meta?.name ?? custCode}: £${Math.round(sales).toLocaleString()} revenue at only ${pct(margin)} margin.`,
        detail: `One of the largest accounts by revenue, but thin margin — worth reviewing pricing or delivery cost for this one.`,
        metric: margin,
      };
    });
}
