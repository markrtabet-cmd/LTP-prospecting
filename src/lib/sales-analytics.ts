// Server-only sales analytics from Power BI (F_DAILY) — feeds the dashboard KPI
// cards and the Insights page. Everything is one bulk DAX pull per metric,
// scoped either to a set of customer account codes (a rep's own book) or to the
// whole company (admins/devs). Deterministic; no LLM.

import { executePowerBIDaxQuery, isPowerBIConfigured } from "./powerbi";
import { classifyCadence } from "./visits/cadence";

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim().replace(/^"|"$/g, "") : fallback;
}

const FACT = env("POWERBI_FACT_TABLE", env("POWERBI_CLIENT_TABLE", "F_DAILY"));
const CODE = env("POWERBI_FACT_CUSTOMER_CODE_COLUMN", "Cust code");
const DATE = env("POWERBI_DATE_COLUMN", "Date");
const SALES = env("POWERBI_VALUE_COLUMN", "Gross Sales");
const WEIGHT = env("POWERBI_WEIGHT_COLUMN", "Net Weight");
const DESC = env("POWERBI_DESCRIPTION_COLUMN", "Description");
const CATEGORY = env("POWERBI_CATEGORY_COLUMN", "Category");
// F_DAILY carries a proper product taxonomy the insights now read directly
// instead of text-searching Description: [Category 2] = PLAIN / FILLED / FILLED
// GNOCCHI / SAUCE / READY MEAL, [Filling] = the actual filling, [Treatment] =
// FRESH / PASTEURISED / FROZEN. (Confirmed against the live dataset schema.)
const CATEGORY2 = env("POWERBI_CATEGORY2_COLUMN", "Category 2");
const FILLING = env("POWERBI_FILLING_COLUMN", "Filling");
const TREATMENT = env("POWERBI_TREATMENT_COLUMN", "Treatment");
const MARKET = env("POWERBI_SECTOR_COLUMN", "Market");
const STATUS = env("POWERBI_ACCOUNT_STATUS_COLUMN", "Account Status");
const NAME = env("POWERBI_FACT_NAME_COLUMN", "Name");
const REP = env("POWERBI_SALES_REP_COLUMN", "Sales Rep");
// NOT POWERBI_POSTCODE_COLUMN — that's the v_CoreCustomer column (PostalCode);
// the fact table's is "Postcode".
const POSTCODE = env("POWERBI_FACT_POSTCODE_COLUMN", "Postcode");
const STOCK = env("POWERBI_STOCK_CODE_COLUMN", "Stock Code");
const QTY = env("POWERBI_QUANTITY_COLUMN", "Quantity");

const T = `'${FACT.replace(/'/g, "''")}'`;
const col = (c: string) => `${T}[${c.replace(/]/g, "]]")}]`;
const daxStr = (s: string) => `"${s.replace(/"/g, '""')}"`;

// Accounting / non-product lines to keep out of the product rankings.
const NON_PRODUCT_CATEGORIES = ["SERVICE", "**DO NOT PRODUCE**", "**AASERVICE**", "OFFICE", "CLEANING"];

export type Scope = string[] | null; // null = company-wide; [] = nothing

/** A DAX table expression for the scoped fact rows. */
function scopedTable(scope: Scope): string {
  if (scope === null) return T;
  if (scope.length === 0) return `FILTER(${T}, FALSE())`;
  return `FILTER(${T}, ${col(CODE)} IN {${scope.map(daxStr).join(", ")}})`;
}
/** A SUMMARIZECOLUMNS filter argument for the scope (with trailing comma), or "". */
function scopeFilterArg(scope: Scope): string {
  if (scope === null) return "";
  if (scope.length === 0) return `FILTER(ALL(${col(CODE)}), FALSE()), `;
  return `FILTER(ALL(${col(CODE)}), ${col(CODE)} IN {${scope.map(daxStr).join(", ")}}), `;
}
function dateFilterArg(fromExclusive: string, toInclusive?: string): string {
  const cond = toInclusive ? `${col(DATE)} > ${fromExclusive} && ${col(DATE)} <= ${toInclusive}` : `${col(DATE)} > ${fromExclusive}`;
  return `FILTER(ALL(${col(DATE)}), ${cond}), `;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function str(v: unknown): string {
  if (v == null) return "";
  const s = String(v).trim();
  return s === "(Blank)" ? "" : s;
}
function isoDay(v: unknown): string | null {
  if (v == null || v === "") return null;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

// ---- KPIs -------------------------------------------------------------------

export interface DashboardKpis {
  configured: boolean;
  activeCustomers: { last30: number; prev30: number; lastYear30: number };
  salesValue: { last30: number; prev30: number; lastYear30: number };
  todaySales: number;
  fyToDate: number; // current fiscal year (1 Jul → today)
  fyPrev: number; // last complete fiscal year
  fyProjection: number; // current FY projected at the run-rate so far
  fyLabel: { current: string; prev: string };
}

/** UK financial year runs 1 Jul → 30 Jun. */
function fyBounds(now: Date) {
  const y = now.getFullYear();
  const startYear = now.getMonth() >= 6 ? y : y - 1; // Jul = month index 6
  return { startYear };
}

export async function fetchDashboardKpis(scope: Scope, now: Date = new Date()): Promise<DashboardKpis> {
  const empty: DashboardKpis = {
    configured: false,
    activeCustomers: { last30: 0, prev30: 0, lastYear30: 0 },
    salesValue: { last30: 0, prev30: 0, lastYear30: 0 },
    todaySales: 0, fyToDate: 0, fyPrev: 0, fyProjection: 0,
    fyLabel: { current: "", prev: "" },
  };
  if (!isPowerBIConfigured()) return empty;

  const { startYear } = fyBounds(now);
  const S = scopedTable(scope);
  const win = (cond: string) => `FILTER(Scoped, ${cond})`;
  const d = col(DATE), s = col(SALES), c = col(CODE);
  const distinct = (t: string) => `COUNTROWS(SUMMARIZE(FILTER(${t}, ${s} > 0), ${c}))`;

  const dax = `EVALUATE
VAR Scoped = ${S}
VAR W30 = ${win(`${d} > TODAY()-30`)}
VAR W30p = ${win(`${d} > TODAY()-60 && ${d} <= TODAY()-30`)}
VAR W30y = ${win(`${d} > TODAY()-395 && ${d} <= TODAY()-365`)}
VAR Wtoday = ${win(`${d} >= TODAY() && ${d} < TODAY()+1`)}
VAR Wfy = ${win(`${d} >= DATE(${startYear},7,1) && ${d} < TODAY()+1`)}
VAR WfyPrev = ${win(`${d} >= DATE(${startYear - 1},7,1) && ${d} <= DATE(${startYear},6,30)`)}
RETURN ROW(
  "sales30", SUMX(W30, ${s}), "sales30p", SUMX(W30p, ${s}), "sales30y", SUMX(W30y, ${s}),
  "active30", ${distinct("W30")}, "active30p", ${distinct("W30p")}, "active30y", ${distinct("W30y")},
  "today", SUMX(Wtoday, ${s}), "fyToDate", SUMX(Wfy, ${s}), "fyPrev", SUMX(WfyPrev, ${s})
)`;

  const rows = await executePowerBIDaxQuery(dax);
  const r = rows[0] ?? {};
  const fyToDate = num(r["fyToDate"]);
  const fyStart = new Date(startYear, 6, 1);
  const daysElapsed = Math.max(1, Math.round((now.getTime() - fyStart.getTime()) / 86_400_000) + 1);
  const fyLenDays = Math.round((new Date(startYear + 1, 6, 1).getTime() - fyStart.getTime()) / 86_400_000);
  return {
    configured: true,
    activeCustomers: { last30: num(r["active30"]), prev30: num(r["active30p"]), lastYear30: num(r["active30y"]) },
    salesValue: { last30: num(r["sales30"]), prev30: num(r["sales30p"]), lastYear30: num(r["sales30y"]) },
    todaySales: num(r["today"]),
    fyToDate,
    fyPrev: num(r["fyPrev"]),
    fyProjection: Math.round((fyToDate / daysElapsed) * fyLenDays),
    fyLabel: { current: `${startYear}/${String(startYear + 1).slice(2)}`, prev: `${startYear - 1}/${String(startYear).slice(2)}` },
  };
}

// ---- Insights ---------------------------------------------------------------

export interface CustomerValue { code: string; name: string; sales: number; kg: number; prevSales: number }
// prevKg / prevSales are the SAME entry's figures for the previous 30-day window
// (0 when it didn't sell then), so each row can show its own vs-prev-30d delta.
export interface ProductValue { description: string; category: string; kg: number; sales: number; prevKg: number; prevSales: number }
export interface SegmentValue { segment: string; sales: number; prevSales: number }
// One line of the report's "Monthly Samples Lines" page — a £0 fact row at the
// (rep, customer, name, postcode, date, stock, description) grain. Samples to
// PROSPECTS are booked on the rep's own pseudo-account (Cust code = the rep's
// first name, e.g. TURI), with [Name] holding the actual recipient.
export interface SampleRow {
  custCode: string;
  name: string;
  postcode: string;
  date: string | null;
  stockCode: string;
  description: string;
  qty: number;
  isProspect: boolean; // Cust code equals the row's Sales Rep (pseudo-account)
}
export interface AttentionRow { code: string; name: string; tierLabel: string | null; daysSinceLast: number | null }

// Current-30d vs previous-30d grand totals, per metric — powers the small
// "vs prev 30d" side notes on the 30-day insight cards.
export interface SalesTotals {
  // Lasagna 30d + prev-30d — the only grand totals still shown (its card keeps a
  // single-stat prev note; every other card moved to per-row deltas).
  lasKg30: number; lasSales30: number; lasSalesPrev: number;
}

export interface SalesInsights {
  configured: boolean;
  perCustomer: CustomerValue[]; // 30d + prev-30d + kg, scoped, sales>0
  // Prev-30d per customer (code, name, prevSales), scoped, prevSales>0. Includes
  // customers who sold in the PREVIOUS window but not the current one, so a group
  // delta (aggregated by name) counts a member who churned to £0 this period —
  // otherwise the group's prior baseline is understated and a drop reads as flat.
  perCustomerPrev: { code: string; name: string; prevSales: number }[];
  segments30: SegmentValue[];
  onStopNew: { code: string; name: string }[];
  attention: AttentionRow[];
  productsTop: ProductValue[]; // 30d, real products only, sorted by sales desc
  lasagnaReadyToCook: { kg: number; sales: number };
  fillingsTopKg: ProductValue[];
  pasteurisedTopKg: ProductValue[];
  samples10: SampleRow[];
  totals?: SalesTotals;
  generatedAt: string;
}

async function safe(dax: string): Promise<Record<string, unknown>[]> {
  try {
    return await executePowerBIDaxQuery(dax);
  } catch (e) {
    if (process.env.DEBUG_SALES_ANALYTICS) console.error("[sales-analytics]", e instanceof Error ? e.message : e, "\nDAX:", dax);
    return [];
  }
}

export async function fetchSalesInsights(
  scope: Scope,
  // repName scopes the samples list by F_DAILY[Sales Rep] (first name, e.g.
  // "Turi Palumbo" → TURI) — prospect samples sit on the rep's pseudo-account,
  // whose code is never in the customer-code roster.
  opts: { repName?: string | null } = {},
  now: Date = new Date(),
): Promise<SalesInsights> {
  const base: SalesInsights = {
    configured: isPowerBIConfigured(),
    perCustomer: [], perCustomerPrev: [], segments30: [], onStopNew: [], attention: [], productsTop: [],
    lasagnaReadyToCook: { kg: 0, sales: 0 }, fillingsTopKg: [], pasteurisedTopKg: [], samples10: [],
    generatedAt: now.toISOString(),
  };
  if (!isPowerBIConfigured()) return base;

  const sc = scopeFilterArg(scope);
  const S = scopedTable(scope);
  const d = col(DATE), s = col(SALES), w = col(WEIGHT), c = col(CODE), nm = col(NAME), de = col(DESC), ca = col(CATEGORY);
  const ca2 = col(CATEGORY2), fi = col(FILLING), tr = col(TREATMENT);
  const notNonProduct = NON_PRODUCT_CATEGORIES.map((x) => `${ca} <> ${daxStr(x)}`).join(" && ");

  // Per-customer 30d and prev-30d (joined client-side by code).
  const perCust30 = `EVALUATE SUMMARIZECOLUMNS(${c}, ${nm}, ${sc}${dateFilterArg("TODAY()-30")}"sales", SUM(${s}), "kg", SUM(${w})) ORDER BY [sales] DESC`;
  const perCustPrev = `EVALUATE SUMMARIZECOLUMNS(${c}, ${nm}, ${sc}${dateFilterArg("TODAY()-60", "TODAY()-30")}"sales", SUM(${s}))`;
  // Segments (Market) 30d value + the prev-30d value per segment (joined by
  // Market in JS) so each segment row shows its own vs-prev delta.
  const segs = `EVALUATE SUMMARIZECOLUMNS(${col(MARKET)}, ${sc}${dateFilterArg("TODAY()-30")}"sales", SUM(${s})) ORDER BY [sales] DESC`;
  const segsPrev = `EVALUATE SUMMARIZECOLUMNS(${col(MARKET)}, ${sc}${dateFilterArg("TODAY()-60", "TODAY()-30")}"sales", SUM(${s}))`;
  // Products 30d (real products only) — top by sales; the client also derives top-by-kg.
  const prods = `EVALUATE TOPN(60, SUMMARIZECOLUMNS(${de}, ${ca}, ${sc}${dateFilterArg("TODAY()-30")}"kg", SUM(${w}), "sales", SUM(${s})), [sales], DESC)`;
  // Prev-30d per product (by Description) — no TOPN, so any product shown for the
  // current window can find its prior figures to compute a per-row delta.
  const prodsPrev = `EVALUATE SUMMARIZECOLUMNS(${de}, ${sc}${dateFilterArg("TODAY()-60", "TODAY()-30")}"kg", SUM(${w}), "sales", SUM(${s}))`;
  // Product filters reused across the ranked queries and the totals ROW.
  // Lasagna = the report's "Lasagna & Sauces" page (Product Sales, READY MEAL
  // toggle): [Category 2] = "READY MEAL" excluding the HOMEDE account. NOT
  // [Category] = "LASAGNA" — that's the PLAIN lasagna SHEETS. Zero-priced lines
  // stay in: the page's qty/kg totals include them (verified live — BEEF
  // LASAGNA FRESH LTP, JUL-2026 = 304 qty / 1,520 kg / £12,808).
  const lasFilter = `FILTER(ALL(${ca2}), ${ca2} = ${daxStr("READY MEAL")}), FILTER(ALL(${c}), ${c} <> ${daxStr("HOMEDE")})`;
  const fillFilter = `FILTER(ALL(${ca2}), ${ca2} IN {${daxStr("FILLED")}, ${daxStr("FILLED GNOCCHI")}})`;
  const pastFilter = `FILTER(ALL(${tr}), ${tr} = ${daxStr("PASTEURISED")})`;
  // Fillings top by kg 30d — grouped by the real [Filling], within filled pasta
  // ([Category 2] = FILLED / FILLED GNOCCHI), not a hardcoded [Category] list.
  const fillings = `EVALUATE TOPN(10, SUMMARIZECOLUMNS(${fi}, ${sc}${fillFilter}, ${dateFilterArg("TODAY()-30")}"kg", SUM(${w}), "sales", SUM(${s})), [kg], DESC)`;
  const fillingsPrev = `EVALUATE SUMMARIZECOLUMNS(${fi}, ${sc}${fillFilter}, ${dateFilterArg("TODAY()-60", "TODAY()-30")}"kg", SUM(${w}), "sales", SUM(${s}))`;
  // Pasteurised top by kg 30d — the real [Treatment] = "PASTEURISED", not a
  // Description text-search for "PST".
  const pasteurised = `EVALUATE TOPN(10, SUMMARIZECOLUMNS(${de}, ${ca}, ${sc}${pastFilter}, ${dateFilterArg("TODAY()-30")}"kg", SUM(${w}), "sales", SUM(${s})), [kg], DESC)`;
  const pasteurisedPrev = `EVALUATE SUMMARIZECOLUMNS(${de}, ${sc}${pastFilter}, ${dateFilterArg("TODAY()-60", "TODAY()-30")}"kg", SUM(${w}), "sales", SUM(${s}))`;
  // Current-30d vs previous-30d grand totals — powers the "vs prev 30d" side
  // notes and the lasagna card (replaces the standalone lasagna ROW).
  const sn = scopeFilterNoTrail(scope);
  const d30 = dateFilterNoTrail("TODAY()-30");
  const dPrev = betweenDateNoTrail("TODAY()-60", "TODAY()-30");
  const calc = (agg: string, filter: string, dwin: string) => `CALCULATE(${agg}, ${sn}${filter ? `${filter}, ` : ""}${dwin})`;
  // Only the lasagna figures survive: the other 30d-vs-prev grand totals became
  // dead once the insight cards moved to per-row deltas, so we no longer compute
  // them (fewer CALCULATE measures per insights load).
  const totalsQ = `EVALUATE ROW(` + [
    `"lasKg30", ${calc(`SUM(${w})`, lasFilter, d30)}`,
    `"lasSales30", ${calc(`SUM(${s})`, lasFilter, d30)}`,
    `"lasSalesPrev", ${calc(`SUM(${s})`, lasFilter, dPrev)}`,
  ].join(", ") + `)`;
  // Samples exactly as the report's "Monthly Samples Lines" page defines them:
  // SUM(Gross Sales) = 0 at the line grain, minus Bicester Village / Home
  // Delivery names. NO weight condition — MESSAGE lines (kg 0) are part of the
  // report. Wide window so the Insights page can filter to any chosen date.
  // Rep scope goes through [Sales Rep] (not the customer-code list) so prospect
  // samples on the rep's pseudo-account are included.
  const repFirst = (opts.repName ?? "").trim().split(/\s+/)[0]?.toUpperCase() ?? "";
  const rp = col(REP), pc = col(POSTCODE), st = col(STOCK), qt = col(QTY);
  const sampleScope = scope === null ? "" : repFirst ? `FILTER(ALL(${rp}), ${rp} = ${daxStr(repFirst)}), ` : sc;
  const samples = `EVALUATE FILTER(SUMMARIZECOLUMNS(${rp}, ${c}, ${nm}, ${pc}, ${d}, ${st}, ${de}, ${sampleScope}${dateFilterArg("TODAY()-90")}"qty", SUM(${qt}), "sales", SUM(${s})), [sales] = 0 && NOT CONTAINSSTRING(${nm}, ${daxStr("BICESTER VILLAGE")}) && NOT CONTAINSSTRING(${nm}, ${daxStr("HOME DELIVERY")}))`;
  // Customers with an "On Stop" status row in the last 10 days. (True "newly on
  // stop" is near-empty here because on-stop accounts stop generating fact rows,
  // so this shows who is on stop over the window — the useful, non-empty read.)
  const onStop = `EVALUATE SUMMARIZE(FILTER(${S}, ${d} > TODAY()-10 && ${col(STATUS)} = "On Stop"), ${c}, ${nm})`;
  // One row per (customer, ORDER day) over 210d → cadence attention in JS. Only
  // real order days count: [sales] > 0 excludes £0 sample-only days (samples are
  // Gross Sales = 0), which would otherwise reset "days since last order" and
  // hide a genuinely lapsing customer from the attention list. Matches the rest
  // of this file, which gates active/order on sales > 0.
  const orderDates = `EVALUATE FILTER(SUMMARIZECOLUMNS(${c}, ${nm}, ${d}, ${sc}${dateFilterArg("TODAY()-210")}"sales", SUM(${s})), [sales] > 0)`;

  const [r30, rPrev, rSeg, rSegPrev, rProd, rProdPrev, rTot, rFill, rFillPrev, rPast, rPastPrev, rSamp, rStop, rOrder] = await Promise.all([
    safe(perCust30), safe(perCustPrev), safe(segs), safe(segsPrev), safe(prods), safe(prodsPrev), safe(totalsQ),
    safe(fillings), safe(fillingsPrev), safe(pasteurised), safe(pasteurisedPrev), safe(samples), safe(onStop), safe(orderDates),
  ]);

  const prevByCode = new Map<string, number>();
  for (const row of rPrev) prevByCode.set(str(row[CODE]), num(row["sales"]));
  // Full prev-30d customer list (incl. those with £0 this period) for accurate
  // group-delta aggregation on the client.
  const perCustomerPrev = rPrev
    .map((row) => ({ code: str(row[CODE]), name: str(row[NAME]), prevSales: num(row["sales"]) }))
    .filter((x) => x.code && x.prevSales > 0);

  // Prev-30d lookups keyed by each card's dimension, for per-row deltas.
  const prevSalesBySegment = new Map<string, number>();
  for (const row of rSegPrev) prevSalesBySegment.set(str(row[MARKET]) || "—", num(row["sales"]));
  const prevByProduct = new Map<string, { kg: number; sales: number }>();
  for (const row of rProdPrev) prevByProduct.set(str(row[DESC]), { kg: num(row["kg"]), sales: num(row["sales"]) });
  const prevByFilling = new Map<string, { kg: number; sales: number }>();
  for (const row of rFillPrev) prevByFilling.set(str(row[FILLING]), { kg: num(row["kg"]), sales: num(row["sales"]) });
  const prevByPast = new Map<string, { kg: number; sales: number }>();
  for (const row of rPastPrev) prevByPast.set(str(row[DESC]), { kg: num(row["kg"]), sales: num(row["sales"]) });

  const perCustomer: CustomerValue[] = r30
    .map((row) => ({ code: str(row[CODE]), name: str(row[NAME]), sales: num(row["sales"]), kg: num(row["kg"]), prevSales: prevByCode.get(str(row[CODE])) ?? 0 }))
    .filter((x) => x.code && x.sales > 0);

  const segments30: SegmentValue[] = rSeg
    .map((row) => {
      const segment = str(row[MARKET]) || "—";
      return { segment, sales: num(row["sales"]), prevSales: prevSalesBySegment.get(segment) ?? 0 };
    })
    .filter((x) => x.sales > 0);

  const productsTop: ProductValue[] = rProd
    .map((row) => {
      const description = str(row[DESC]);
      const p = prevByProduct.get(description);
      return { description, category: str(row[CATEGORY]), kg: num(row["kg"]), sales: num(row["sales"]), prevKg: p?.kg ?? 0, prevSales: p?.sales ?? 0 };
    })
    .filter((p) => p.description && !NON_PRODUCT_CATEGORIES.includes(p.category.toUpperCase()));

  const fillingsTopKg: ProductValue[] = rFill
    .map((row) => {
      const description = str(row[FILLING]);
      const p = prevByFilling.get(description);
      return { description, category: "Filled pasta", kg: num(row["kg"]), sales: num(row["sales"]), prevKg: p?.kg ?? 0, prevSales: p?.sales ?? 0 };
    })
    .filter((p) => p.kg > 0 && p.description && p.description.toUpperCase() !== "NOT APPLICABLE" && !p.description.toUpperCase().startsWith("PLAIN PASTA"));
  const pasteurisedTopKg: ProductValue[] = rPast
    .map((row) => {
      const description = str(row[DESC]);
      const p = prevByPast.get(description);
      return { description, category: str(row[CATEGORY]), kg: num(row["kg"]), sales: num(row["sales"]), prevKg: p?.kg ?? 0, prevSales: p?.sales ?? 0 };
    })
    .filter((p) => p.kg > 0);

  const samples10: SampleRow[] = rSamp
    .map((row) => {
      const custCode = str(row[CODE]);
      const repOnRow = str(row[REP]);
      return {
        custCode,
        name: str(row[NAME]),
        postcode: str(row[POSTCODE]),
        date: isoDay(row[DATE]),
        stockCode: str(row[STOCK]),
        description: str(row[DESC]),
        qty: num(row["qty"]),
        isProspect: custCode !== "" && custCode.toUpperCase() === repOnRow.toUpperCase(),
      };
    })
    .filter((x) => x.custCode && x.date)
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  const onStopNew = rStop.map((row) => ({ code: str(row[CODE]), name: str(row[NAME]) })).filter((x) => x.code);

  // Cadence attention from the pulled order dates.
  const datesByCode = new Map<string, { name: string; dates: string[] }>();
  for (const row of rOrder) {
    const code = str(row[CODE]);
    const day = isoDay(row[DATE]);
    if (!code || !day) continue;
    const e = datesByCode.get(code) ?? { name: str(row[NAME]), dates: [] };
    e.dates.push(day);
    datesByCode.set(code, e);
  }
  const attention: AttentionRow[] = [];
  datesByCode.forEach((e, code) => {
    const v = classifyCadence(e.dates, now);
    if (v.attention) attention.push({ code, name: e.name, tierLabel: v.tierLabel, daysSinceLast: v.daysSinceLast });
  });
  attention.sort((a, b) => (b.daysSinceLast ?? 0) - (a.daysSinceLast ?? 0));

  const totRow = rTot[0] ?? {};
  const totals: SalesTotals = {
    lasKg30: num(totRow["lasKg30"]),
    lasSales30: num(totRow["lasSales30"]), lasSalesPrev: num(totRow["lasSalesPrev"]),
  };

  return {
    ...base,
    perCustomer,
    perCustomerPrev,
    segments30,
    onStopNew,
    attention,
    productsTop,
    lasagnaReadyToCook: { kg: totals.lasKg30, sales: totals.lasSales30 },
    fillingsTopKg,
    pasteurisedTopKg,
    samples10,
    totals,
  };
}

// CALCULATE filter args (no trailing comma/space) for the single-ROW lasagna query.
function scopeFilterNoTrail(scope: Scope): string {
  if (scope === null) return "";
  if (scope.length === 0) return `FILTER(ALL(${col(CODE)}), FALSE()), `;
  return `FILTER(ALL(${col(CODE)}), ${col(CODE)} IN {${scope.map(daxStr).join(", ")}}), `;
}
function dateFilterNoTrail(fromExclusive: string): string {
  return `FILTER(ALL(${col(DATE)}), ${col(DATE)} > ${fromExclusive})`;
}
function betweenDateNoTrail(fromExclusive: string, toInclusive: string): string {
  return `FILTER(ALL(${col(DATE)}), ${col(DATE)} > ${fromExclusive} && ${col(DATE)} <= ${toInclusive})`;
}
