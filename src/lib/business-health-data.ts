// Bulk Power BI fetch for the weekly business-health summary. One query per
// shape, each aggregated server-side (GROUPBY/SUMMARIZE) rather than pulling
// raw F_DAILY rows — the fact table spans 3.5+ years across thousands of
// customers, so anything row-level would be enormous. Feeds the pure
// detectors in business-health.ts.

import { executePowerBIDaxQuery } from "./powerbi";
import type {
  ChannelMonthPoint,
  CategoryWindowPoint,
  CustomerMeta,
  CustomerMonthPoint,
  OrderFrequencyRow,
} from "./business-health";

const FACT_TABLE = "F_DAILY";
const PRODUCT_WINDOW_DAYS = 90;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function str(v: unknown): string {
  if (v == null) return "";
  const s = String(v).trim();
  return s === "(Blank)" ? "" : s;
}

/** Per-customer, per-calendar-month sales + cost, last ~13 months. */
export async function fetchCustomerMonthly(): Promise<CustomerMonthPoint[]> {
  const dax = `EVALUATE
VAR Fact = FILTER('${FACT_TABLE}', '${FACT_TABLE}'[Date] >= DATE(YEAR(TODAY()) - 1, MONTH(TODAY()), 1))
VAR WithYM = ADDCOLUMNS(Fact, "@y", YEAR('${FACT_TABLE}'[Date]), "@m", MONTH('${FACT_TABLE}'[Date]))
RETURN GROUPBY(
  WithYM, '${FACT_TABLE}'[Cust code], [@y], [@m],
  "sales", SUMX(CURRENTGROUP(), '${FACT_TABLE}'[Gross Sales]),
  "cost", SUMX(CURRENTGROUP(), '${FACT_TABLE}'[Total Cost])
)`;
  const rows = await executePowerBIDaxQuery(dax);
  return rows
    .map((r) => ({
      custCode: str(r["Cust code"]),
      year: num(r["@y"]),
      month: num(r["@m"]),
      sales: num(r["sales"]),
      cost: num(r["cost"]),
      orders: 0, // not derivable from a GROUPBY aggregate; not used by any detector yet
    }))
    .filter((r) => r.custCode && r.year && r.month);
}

/** One row per customer with recent activity — name, rep (most recent
 * non-blank, since a single latest transaction can easily leave this blank),
 * channel, customer group, route, first-sale date. */
export async function fetchCustomerMeta(): Promise<CustomerMeta[]> {
  const dax = `EVALUATE
VAR Recent = FILTER('${FACT_TABLE}', '${FACT_TABLE}'[Date] >= DATE(YEAR(TODAY()) - 2, 1, 1))
VAR Codes = SUMMARIZE(Recent, '${FACT_TABLE}'[Cust code])
RETURN ADDCOLUMNS(
  Codes,
  "name", CALCULATE(MAXX(TOPN(1, '${FACT_TABLE}', '${FACT_TABLE}'[Date], DESC), '${FACT_TABLE}'[Name])),
  "rep", CALCULATE(MAXX(TOPN(1, FILTER('${FACT_TABLE}', NOT ISBLANK('${FACT_TABLE}'[Sales Rep])), '${FACT_TABLE}'[Date], DESC), '${FACT_TABLE}'[Sales Rep])),
  "channel", CALCULATE(MAXX(TOPN(1, '${FACT_TABLE}', '${FACT_TABLE}'[Date], DESC), '${FACT_TABLE}'[Management Report1])),
  "custGroup", CALCULATE(MAXX(TOPN(1, '${FACT_TABLE}', '${FACT_TABLE}'[Date], DESC), '${FACT_TABLE}'[Customer Group])),
  "route", CALCULATE(MAXX(TOPN(1, '${FACT_TABLE}', '${FACT_TABLE}'[Date], DESC), '${FACT_TABLE}'[Route])),
  "firstSale", CALCULATE(MIN('${FACT_TABLE}'[Date]))
)`;
  const rows = await executePowerBIDaxQuery(dax);
  return rows
    .map((r) => ({
      custCode: str(r["Cust code"]),
      name: str(r["name"]) || str(r["Cust code"]),
      salesRep: str(r["rep"]) || null,
      channel: str(r["channel"]) || null,
      customerGroup: str(r["custGroup"]) || null,
      route: str(r["route"]) || null,
      firstSaleDate: r["firstSale"] ? String(r["firstSale"]).slice(0, 10) : null,
    }))
    .filter((r) => r.custCode);
}

/** Power BI's own per-customer order-cadence tracker — already computes
 * expected order date + days over it, so this is a straight pull, not a
 * re-derivation. */
export async function fetchOrderFrequency(): Promise<OrderFrequencyRow[]> {
  const rows = await executePowerBIDaxQuery(`EVALUATE 'v_OrderFrequency'`);
  return rows
    .map((r) => ({
      custCode: str(r["Cust code"]),
      name: str(r["Name"]) || str(r["Cust code"]),
      status: str(r["Status"]),
      orderFrequencyDays: r["Order Frequency (Days)"] != null ? num(r["Order Frequency (Days)"]) : null,
      daysOverExpected: r["Days over Expected Order Date"] != null ? num(r["Days over Expected Order Date"]) : null,
      expectedOrderValue: r["Expected Order Value"] != null ? num(r["Expected Order Value"]) : null,
    }))
    .filter((r) => r.custCode);
}

/** Per-customer, per-product-category totals over two rolling windows — same
 * recent-vs-prior shape as the calendar's product-switch sync, but grouped by
 * the model's own Category field rather than raw Stock Code. */
export async function fetchCategoryWindows(): Promise<CategoryWindowPoint[]> {
  const dax = `EVALUATE
VAR RecentStart = TODAY() - ${PRODUCT_WINDOW_DAYS}
VAR PriorStart = TODAY() - ${PRODUCT_WINDOW_DAYS * 2}
VAR Fact = FILTER('${FACT_TABLE}', '${FACT_TABLE}'[Date] >= PriorStart)
VAR WithBucket = ADDCOLUMNS(Fact, "@bucket", IF('${FACT_TABLE}'[Date] >= RecentStart, "recent", "prior"))
RETURN GROUPBY(
  WithBucket, '${FACT_TABLE}'[Cust code], '${FACT_TABLE}'[Category], [@bucket],
  "sales", SUMX(CURRENTGROUP(), '${FACT_TABLE}'[Gross Sales])
)`;
  const rows = await executePowerBIDaxQuery(dax);
  return rows
    .map((r) => ({
      custCode: str(r["Cust code"]),
      category: str(r["Category"]),
      window: str(r["@bucket"]) as "recent" | "prior",
      sales: num(r["sales"]),
    }))
    .filter((r) => r.custCode && r.category && (r.window === "recent" || r.window === "prior"));
}

/** Sales by channel (Management Report1: wholesale / B2C / retail / …) by
 * calendar month, last ~13 months. */
export async function fetchChannelMonthly(): Promise<ChannelMonthPoint[]> {
  const dax = `EVALUATE
VAR Fact = FILTER('${FACT_TABLE}', '${FACT_TABLE}'[Date] >= DATE(YEAR(TODAY()) - 1, MONTH(TODAY()), 1))
VAR WithYM = ADDCOLUMNS(Fact, "@y", YEAR('${FACT_TABLE}'[Date]), "@m", MONTH('${FACT_TABLE}'[Date]))
RETURN GROUPBY(
  WithYM, '${FACT_TABLE}'[Management Report1], [@y], [@m],
  "sales", SUMX(CURRENTGROUP(), '${FACT_TABLE}'[Gross Sales])
)`;
  const rows = await executePowerBIDaxQuery(dax);
  return rows
    .map((r) => ({
      channel: str(r["Management Report1"]) || "Unclassified",
      year: num(r["@y"]),
      month: num(r["@m"]),
      sales: num(r["sales"]),
    }))
    .filter((r) => r.year && r.month);
}
