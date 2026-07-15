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
export interface ProductValue { description: string; category: string; kg: number; sales: number }
export interface SegmentValue { segment: string; sales: number }
export interface SampleRow { code: string; name: string; date: string | null }
export interface AttentionRow { code: string; name: string; tierLabel: string | null; daysSinceLast: number | null }

// Current-30d vs previous-30d grand totals, per metric — powers the small
// "vs prev 30d" side notes on the 30-day insight cards.
export interface SalesTotals {
  sales30: number; salesPrev: number; // all scoped sales (£)
  kg30: number; kgPrev: number; // all product volume (kg)
  fillKg30: number; fillKgPrev: number; // filled-pasta volume (kg)
  pastKg30: number; pastKgPrev: number; // pasteurised volume (kg)
  lasKg30: number; lasKgPrev: number; lasSales30: number; lasSalesPrev: number;
}

export interface SalesInsights {
  configured: boolean;
  perCustomer: CustomerValue[]; // 30d + prev-30d + kg, scoped, sales>0
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
  } catch {
    return [];
  }
}

export async function fetchSalesInsights(scope: Scope, now: Date = new Date()): Promise<SalesInsights> {
  const base: SalesInsights = {
    configured: isPowerBIConfigured(),
    perCustomer: [], segments30: [], onStopNew: [], attention: [], productsTop: [],
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
  // Segments (Market) 30d value.
  const segs = `EVALUATE SUMMARIZECOLUMNS(${col(MARKET)}, ${sc}${dateFilterArg("TODAY()-30")}"sales", SUM(${s})) ORDER BY [sales] DESC`;
  // Products 30d (real products only) — top by sales; the client also derives top-by-kg.
  const prods = `EVALUATE TOPN(60, SUMMARIZECOLUMNS(${de}, ${ca}, ${sc}${dateFilterArg("TODAY()-30")}"kg", SUM(${w}), "sales", SUM(${s})), [sales], DESC)`;
  // Product filters reused across the ranked queries and the totals ROW.
  const lasFilter = `FILTER(ALL(${ca}), ${ca} = ${daxStr("LASAGNA")})`;
  const fillFilter = `FILTER(ALL(${ca2}), ${ca2} IN {${daxStr("FILLED")}, ${daxStr("FILLED GNOCCHI")}})`;
  const pastFilter = `FILTER(ALL(${tr}), ${tr} = ${daxStr("PASTEURISED")})`;
  // Fillings top by kg 30d — grouped by the real [Filling], within filled pasta
  // ([Category 2] = FILLED / FILLED GNOCCHI), not a hardcoded [Category] list.
  const fillings = `EVALUATE TOPN(10, SUMMARIZECOLUMNS(${fi}, ${sc}${fillFilter}, ${dateFilterArg("TODAY()-30")}"kg", SUM(${w}), "sales", SUM(${s})), [kg], DESC)`;
  // Pasteurised top by kg 30d — the real [Treatment] = "PASTEURISED", not a
  // Description text-search for "PST".
  const pasteurised = `EVALUATE TOPN(10, SUMMARIZECOLUMNS(${de}, ${ca}, ${sc}${pastFilter}, ${dateFilterArg("TODAY()-30")}"kg", SUM(${w}), "sales", SUM(${s})), [kg], DESC)`;
  // Current-30d vs previous-30d grand totals — powers the "vs prev 30d" side
  // notes and the lasagna card (replaces the standalone lasagna ROW).
  const sn = scopeFilterNoTrail(scope);
  const d30 = dateFilterNoTrail("TODAY()-30");
  const dPrev = betweenDateNoTrail("TODAY()-60", "TODAY()-30");
  const calc = (agg: string, filter: string, dwin: string) => `CALCULATE(${agg}, ${sn}${filter ? `${filter}, ` : ""}${dwin})`;
  const totalsQ = `EVALUATE ROW(` + [
    `"sales30", ${calc(`SUM(${s})`, "", d30)}`,
    `"salesPrev", ${calc(`SUM(${s})`, "", dPrev)}`,
    `"kg30", ${calc(`SUM(${w})`, "", d30)}`,
    `"kgPrev", ${calc(`SUM(${w})`, "", dPrev)}`,
    `"fillKg30", ${calc(`SUM(${w})`, fillFilter, d30)}`,
    `"fillKgPrev", ${calc(`SUM(${w})`, fillFilter, dPrev)}`,
    `"pastKg30", ${calc(`SUM(${w})`, pastFilter, d30)}`,
    `"pastKgPrev", ${calc(`SUM(${w})`, pastFilter, dPrev)}`,
    `"lasKg30", ${calc(`SUM(${w})`, lasFilter, d30)}`,
    `"lasKgPrev", ${calc(`SUM(${w})`, lasFilter, dPrev)}`,
    `"lasSales30", ${calc(`SUM(${s})`, lasFilter, d30)}`,
    `"lasSalesPrev", ${calc(`SUM(${s})`, lasFilter, dPrev)}`,
  ].join(", ") + `)`;
  // Samples: £0 + weight>0 lines in last 10d, per customer, latest date. Counted
  // with a CALCULATE measure inside SUMMARIZECOLUMNS (GROUPBY can't take a
  // filtered VAR table); JS keeps only customers with at least one sample line.
  // One row per (customer, day) with a £0 + weight>0 sample line, over a wide
  // window so the Insights page can filter to any chosen date (not just 10d).
  const samples = `EVALUATE SUMMARIZE(FILTER(${S}, ${d} > TODAY()-90 && ${s} = 0 && ${w} > 0), ${c}, ${nm}, ${d})`;
  // Customers with an "On Stop" status row in the last 10 days. (True "newly on
  // stop" is near-empty here because on-stop accounts stop generating fact rows,
  // so this shows who is on stop over the window — the useful, non-empty read.)
  const onStop = `EVALUATE SUMMARIZE(FILTER(${S}, ${d} > TODAY()-10 && ${col(STATUS)} = "On Stop"), ${c}, ${nm})`;
  // One row per (customer, order day) over 210d → cadence attention in JS.
  const orderDates = `EVALUATE SUMMARIZECOLUMNS(${c}, ${nm}, ${d}, ${sc}${dateFilterArg("TODAY()-210")}"sales", SUM(${s}))`;

  const [r30, rPrev, rSeg, rProd, rTot, rFill, rPast, rSamp, rStop, rOrder] = await Promise.all([
    safe(perCust30), safe(perCustPrev), safe(segs), safe(prods), safe(totalsQ),
    safe(fillings), safe(pasteurised), safe(samples), safe(onStop), safe(orderDates),
  ]);

  const prevByCode = new Map<string, number>();
  for (const row of rPrev) prevByCode.set(str(row[CODE]), num(row["sales"]));

  const perCustomer: CustomerValue[] = r30
    .map((row) => ({ code: str(row[CODE]), name: str(row[NAME]), sales: num(row["sales"]), kg: num(row["kg"]), prevSales: prevByCode.get(str(row[CODE])) ?? 0 }))
    .filter((x) => x.code && x.sales > 0);

  const segments30: SegmentValue[] = rSeg
    .map((row) => ({ segment: str(row[MARKET]) || "—", sales: num(row["sales"]) }))
    .filter((x) => x.sales > 0);

  const productsTop: ProductValue[] = rProd
    .map((row) => ({ description: str(row[DESC]), category: str(row[CATEGORY]), kg: num(row["kg"]), sales: num(row["sales"]) }))
    .filter((p) => p.description && !NON_PRODUCT_CATEGORIES.includes(p.category.toUpperCase()));

  const fillingsTopKg: ProductValue[] = rFill
    .map((row) => ({ description: str(row[FILLING]), category: "Filled pasta", kg: num(row["kg"]), sales: num(row["sales"]) }))
    .filter((p) => p.kg > 0 && p.description && p.description.toUpperCase() !== "NOT APPLICABLE" && !p.description.toUpperCase().startsWith("PLAIN PASTA"));
  const pasteurisedTopKg: ProductValue[] = rPast.map((row) => ({ description: str(row[DESC]), category: str(row[CATEGORY]), kg: num(row["kg"]), sales: num(row["sales"]) })).filter((p) => p.kg > 0);

  const samples10: SampleRow[] = rSamp
    .map((row) => ({ code: str(row[CODE]), name: str(row[NAME]), date: isoDay(row[DATE]) }))
    .filter((x) => x.code && x.date)
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
    sales30: num(totRow["sales30"]), salesPrev: num(totRow["salesPrev"]),
    kg30: num(totRow["kg30"]), kgPrev: num(totRow["kgPrev"]),
    fillKg30: num(totRow["fillKg30"]), fillKgPrev: num(totRow["fillKgPrev"]),
    pastKg30: num(totRow["pastKg30"]), pastKgPrev: num(totRow["pastKgPrev"]),
    lasKg30: num(totRow["lasKg30"]), lasKgPrev: num(totRow["lasKgPrev"]),
    lasSales30: num(totRow["lasSales30"]), lasSalesPrev: num(totRow["lasSalesPrev"]),
  };

  return {
    ...base,
    perCustomer,
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
