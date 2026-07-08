import { NextResponse } from "next/server";
import {
  executePowerBIDaxQuery,
  fetchPowerBICustomers,
  getDatasetLastRefreshTime,
  isPowerBIConfigured,
  type PowerBICustomer,
} from "@/lib/powerbi";

// Live per-customer Power BI data for the mobile Contact + Sales panels.
// Everything is queried fresh on each request (no copies): account/terms fields
// from v_CoreCustomer, status/route/rep from the latest F_DAILY row, the
// contacts list from v_CoreCustomerContacts, monthly sales for the rolling last
// 12 months (+ calendar YTD), and per-product sales for the rolling last 3
// months. Keyed by CustomerAccountCode, which the nightly sync stores on each
// matched venue. Session-gated by the middleware like the rest of the app.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export interface InsightContact {
  name: string;
  role: string;
  phone1: string;
  phone2: string;
  email: string;
  flags: string[]; // which of Order confirmation / Invoice / Credit / Accounts are "Y"
}

export interface InsightMonth {
  year: number;
  month: number; // 1-12
  sales: number;
  kg: number;
  ytd: number; // calendar-year-to-date sales as of this month
}

export interface InsightProduct {
  code: string;
  description: string;
  kg: number;
  sales: number;
  lastSale: string | null; // ISO date
}

export interface InsightLastOrderLine {
  code: string;
  description: string;
  kg: number;
  sales: number;
}

/** Line-level detail of the customer's most recent sale date. */
export interface InsightLastOrder {
  date: string | null; // ISO date
  documentNos: string[]; // invoice/document numbers on that date
  total: number;
  kg: number;
  lines: InsightLastOrderLine[];
}

export interface CustomerInsights {
  configured: boolean;
  found: boolean;
  resolvedCode?: string;
  linkSource?: "stored_code" | "postcode_lookup" | "name_lookup";
  account?: {
    paymentMethod: string;
    accountStatus: string;
    terms: string;
    priceList: string;
    minOrder: number | null;
    adv: number | null; // average order value (total sales / distinct invoices)
    mainPhone: string;
    lastRoute: string;
    customerGroup: string;
    salesRep: string;
    lastSale: string | null; // ISO date
  };
  contacts: InsightContact[];
  monthly: InsightMonth[]; // oldest → newest, always 12 entries
  products: InsightProduct[];
  lastOrder?: InsightLastOrder;
  diagnostics?: {
    customerRows: number;
    factRows: number;
    totalSales: number;
    latestCustomerSale: string | null;
    latestDatasetSale: string | null;
    datasetRefreshedAt?: string | null;
    stale?: boolean; // dataset stopped refreshing — figures can't be trusted as current
    warnings?: string[];
  };
  error?: string;
}

// Account codes are alphanumeric, but escape quotes anyway for DAX literals.
function daxStr(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function str(v: unknown): string {
  if (v == null) return "";
  const s = String(v).trim();
  return s === "(Blank)" ? "" : s;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isoDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim().replace(/^"|"$/g, "") : fallback;
}

function table(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

function col(tableName: string, columnName: string): string {
  return `${table(tableName)}[${columnName.replace(/]/g, "]]")}]`;
}

function normPostcode(s: string): string {
  return (s || "").toUpperCase().replace(/\s+/g, "").trim();
}

// "restaurant(s)" is stripped alongside the legal-entity words below because
// Power BI often carries a customer's registered/legal name ("TORTELLO
// RESTAURANT LTD") while FSA lists its trading name ("Tortello") — without
// this, the exact-match name-only fallback below can never fire for an
// otherwise-unambiguous customer. Kept in sync with the same function in
// src/lib/customer-sync.ts.
function normName(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|ltd|limited|plc|llp|llc|inc|co|uk|restaurants?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameVariants(raw: string): string[] {
  const out = new Set<string>();
  const full = normName(raw);
  if (full) out.add(full);
  if (raw.includes("(")) {
    const outside = normName(raw.replace(/\([^)]*\)/g, " "));
    if (outside) out.add(outside);
    for (const grp of raw.match(/\([^)]+\)/g) ?? []) {
      const inside = normName(grp.slice(1, -1));
      if (inside && inside.length >= 4) out.add(inside);
    }
  }
  return Array.from(out);
}

function nameScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return 0.86;
  const at = Array.from(new Set(a.split(" ").filter(Boolean)));
  const bt = Array.from(new Set(b.split(" ").filter(Boolean)));
  if (!at.length || !bt.length) return 0;
  const bset = new Set(bt);
  let inter = 0;
  for (const t of at) if (bset.has(t)) inter++;
  const jaccard = inter / (at.length + bt.length - inter);
  return jaccard >= 0.6 ? 0.5 + jaccard * 0.25 : 0;
}

function bestPowerBIMatch(
  customers: PowerBICustomer[],
  name: string,
  postcode: string
): { customer: PowerBICustomer; source: "postcode_lookup" | "name_lookup" } | null {
  const variants = nameVariants(name);
  if (!variants.length) return null;

  const scoreCustomer = (c: PowerBICustomer): number => {
    const candidateVariants = nameVariants(c.name);
    let best = 0;
    for (const a of variants) {
      for (const b of candidateVariants) best = Math.max(best, nameScore(a, b));
    }
    return best;
  };

  const withCodes = customers.filter((c) => c.accountCode);
  const np = normPostcode(postcode);
  const postcodeMatches = np ? withCodes.filter((c) => normPostcode(c.postcode) === np) : [];

  let scored = postcodeMatches
    .map((customer) => ({ customer, score: scoreCustomer(customer) }))
    .filter((m) => m.score >= 0.6)
    .sort((a, b) => b.score - a.score);
  if (scored.length > 0 && (scored.length === 1 || scored[0].score > scored[1].score)) {
    return { customer: scored[0].customer, source: "postcode_lookup" };
  }

  // No postcode match means Power BI may be using a billing/head-office
  // postcode. Name-only fallback is deliberately stricter and must be unique.
  scored = withCodes
    .map((customer) => ({ customer, score: scoreCustomer(customer) }))
    .filter((m) => m.score >= 1)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 1) return { customer: scored[0].customer, source: "name_lookup" };
  return null;
}

const CUSTOMER_TABLE = env("POWERBI_CUSTOMERS_TABLE", "v_CoreCustomer");
const CONTACTS_TABLE = env("POWERBI_CONTACTS_TABLE", "v_CoreCustomerContacts");
const FACT_TABLE = env("POWERBI_FACT_TABLE", env("POWERBI_CLIENT_TABLE", "F_DAILY"));

const CUSTOMER_CODE_COL = env("POWERBI_ACCOUNT_CODE_COLUMN", "CustomerAccountCode");
const CUSTOMER_PAYMENT_COL = env("POWERBI_PAYMENT_METHOD_COLUMN", "PaymentMethod");
const CUSTOMER_MIN_ORDER_COL = env("POWERBI_MIN_ORDER_COLUMN", "MinimumOrderValue");
const CUSTOMER_PRICE_LIST_COL = env("POWERBI_PRICE_LIST_COLUMN", "PriceListCode1");
const CUSTOMER_TERMS_COL = env("POWERBI_TERMS_COLUMN", "DueDateType");
const CUSTOMER_PHONE_COL = env("POWERBI_CONTACT_PHONE_COLUMN", "TelephoneNo");

const CONTACT_CODE_COL = env("POWERBI_CONTACT_ACCOUNT_CODE_COLUMN", CUSTOMER_CODE_COL);
const CONTACT_NAME_COL = env("POWERBI_CONTACT_NAME_COLUMN", "ContactName");
const CONTACT_ROLE_COL = env("POWERBI_CONTACT_ROLE_COLUMN", "ContactRole");
const CONTACT_PHONE1_COL = env("POWERBI_CONTACT_PHONE1_COLUMN", "ContactNumber1");
const CONTACT_PHONE2_COL = env("POWERBI_CONTACT_PHONE2_COLUMN", "ContactNumber2");
const CONTACT_EMAIL_COL = env("POWERBI_CONTACTS_EMAIL_COLUMN", "ContactEmail");
const CONTACT_ORDER_COL = env("POWERBI_CONTACT_ORDER_CONFIRMATION_COLUMN", "Order Confirmation");
const CONTACT_INVOICE_COL = env("POWERBI_CONTACT_INVOICE_COLUMN", "Invoice");
const CONTACT_CREDIT_COL = env("POWERBI_CONTACT_CREDIT_COLUMN", "Credit");
const CONTACT_ACCOUNTS_COL = env("POWERBI_CONTACT_ACCOUNTS_COLUMN", "Accounts");

const FACT_CODE_COL = env("POWERBI_FACT_CUSTOMER_CODE_COLUMN", "Cust code");
const FACT_DATE_COL = env("POWERBI_DATE_COLUMN", "Date");
const FACT_ACCOUNT_STATUS_COL = env("POWERBI_ACCOUNT_STATUS_COLUMN", "Account Status");
const FACT_ROUTE_COL = env("POWERBI_ROUTE_COLUMN", "Route");
const FACT_GROUP_COL = env("POWERBI_CUSTOMER_GROUP_COLUMN", "Customer Group");
const FACT_REP_COL = env("POWERBI_SALES_REP_COLUMN", "Sales Rep");
const FACT_SALES_COL = env("POWERBI_VALUE_COLUMN", "Gross Sales");
const FACT_WEIGHT_COL = env("POWERBI_WEIGHT_COLUMN", "Net Weight");
const FACT_DOCUMENT_COL = env("POWERBI_DOCUMENT_COLUMN", "DocumentNo");
const FACT_STOCK_CODE_COL = env("POWERBI_STOCK_CODE_COLUMN", "Stock Code");
const FACT_DESCRIPTION_COL = env("POWERBI_DESCRIPTION_COLUMN", "Description");

// Each "latest snapshot" field (rep, status, route, group) looks back to its
// OWN most recent non-blank row, rather than one shared "latest row" — a
// customer's single most recent transaction (e.g. a credit note or system
// adjustment) can easily leave one of these blank while every other row has
// it, which used to make an active rep/route/status disappear as "-".
function accountQuery(code: string): string {
  const c = daxStr(code);
  const dateCol = col(FACT_TABLE, FACT_DATE_COL);
  const latestNonBlank = (fieldCol: string) =>
    `TOPN(1, FILTER(Fact, NOT(ISBLANK(${fieldCol}))), ${dateCol}, DESC)`;
  return `EVALUATE
VAR Cust = FILTER(${table(CUSTOMER_TABLE)}, ${col(CUSTOMER_TABLE, CUSTOMER_CODE_COL)} = ${c})
VAR Fact = FILTER(${table(FACT_TABLE)}, ${col(FACT_TABLE, FACT_CODE_COL)} = ${c})
VAR LastRow = TOPN(1, Fact, ${dateCol}, DESC)
VAR LastRepRow = ${latestNonBlank(col(FACT_TABLE, FACT_REP_COL))}
VAR LastStatusRow = ${latestNonBlank(col(FACT_TABLE, FACT_ACCOUNT_STATUS_COL))}
VAR LastRouteRow = ${latestNonBlank(col(FACT_TABLE, FACT_ROUTE_COL))}
VAR LastGroupRow = ${latestNonBlank(col(FACT_TABLE, FACT_GROUP_COL))}
RETURN ROW(
  "found", COUNTROWS(Cust) + COUNTROWS(LastRow),
  "customerRows", COUNTROWS(Cust),
  "factRows", COUNTROWS(Fact),
  "totalSales", SUMX(Fact, ${col(FACT_TABLE, FACT_SALES_COL)}),
  "latestDatasetSale", CALCULATE(MAX(${dateCol}), ALL(${table(FACT_TABLE)})),
  "paymentMethod", MAXX(Cust, ${col(CUSTOMER_TABLE, CUSTOMER_PAYMENT_COL)}),
  "minOrder", MAXX(Cust, ${col(CUSTOMER_TABLE, CUSTOMER_MIN_ORDER_COL)}),
  "priceList", MAXX(Cust, ${col(CUSTOMER_TABLE, CUSTOMER_PRICE_LIST_COL)}),
  "terms", MAXX(Cust, ${col(CUSTOMER_TABLE, CUSTOMER_TERMS_COL)}),
  "mainPhone", MAXX(Cust, ${col(CUSTOMER_TABLE, CUSTOMER_PHONE_COL)}),
  "accountStatus", MAXX(LastStatusRow, ${col(FACT_TABLE, FACT_ACCOUNT_STATUS_COL)}),
  "lastRoute", MAXX(LastRouteRow, ${col(FACT_TABLE, FACT_ROUTE_COL)}),
  "customerGroup", MAXX(LastGroupRow, ${col(FACT_TABLE, FACT_GROUP_COL)}),
  "salesRep", MAXX(LastRepRow, ${col(FACT_TABLE, FACT_REP_COL)}),
  "lastSale", MAXX(Fact, ${dateCol}),
  "adv", DIVIDE(SUMX(Fact, ${col(FACT_TABLE, FACT_SALES_COL)}), COUNTROWS(SUMMARIZE(Fact, ${col(FACT_TABLE, FACT_DOCUMENT_COL)})))
)`;
}

async function optionalQuery(dax: string, label: string, warnings: string[]): Promise<Record<string, unknown>[]> {
  try {
    return await executePowerBIDaxQuery(dax);
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    warnings.push(`${label}: ${message.slice(0, 180)}`);
    return [];
  }
}

async function resolveFromPowerBI(
  name: string,
  postcode: string,
  warnings: string[]
): Promise<{ code: string; source: "postcode_lookup" | "name_lookup" } | null> {
  if (!name.trim()) return null;
  try {
    const match = bestPowerBIMatch(await fetchPowerBICustomers(), name, postcode);
    const code = match?.customer.accountCode?.trim();
    return match && code ? { code, source: match.source } : null;
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    warnings.push(`customer lookup: ${message.slice(0, 180)}`);
    return null;
  }
}

function contactsQuery(code: string): string {
  const c = daxStr(code);
  return `EVALUATE
SELECTCOLUMNS(
  FILTER(${table(CONTACTS_TABLE)}, ${col(CONTACTS_TABLE, CONTACT_CODE_COL)} = ${c}),
  "name", ${col(CONTACTS_TABLE, CONTACT_NAME_COL)},
  "role", ${col(CONTACTS_TABLE, CONTACT_ROLE_COL)},
  "phone1", ${col(CONTACTS_TABLE, CONTACT_PHONE1_COL)},
  "phone2", ${col(CONTACTS_TABLE, CONTACT_PHONE2_COL)},
  "email", ${col(CONTACTS_TABLE, CONTACT_EMAIL_COL)},
  "flagOrder", ${col(CONTACTS_TABLE, CONTACT_ORDER_COL)},
  "flagInvoice", ${col(CONTACTS_TABLE, CONTACT_INVOICE_COL)},
  "flagCredit", ${col(CONTACTS_TABLE, CONTACT_CREDIT_COL)},
  "flagAccounts", ${col(CONTACTS_TABLE, CONTACT_ACCOUNTS_COL)}
)`;
}

// Fetch monthly aggregates from 1 Jan of LAST year: enough history to compute a
// calendar YTD for every month in the rolling 12-month window. Grouped by
// YEAR/MONTH of the sale date — the model's own [Year]/[Month Number] columns
// are FISCAL (April-start), not calendar.
function monthlyQuery(code: string): string {
  const c = daxStr(code);
  return `EVALUATE
VAR Fact = FILTER(${table(FACT_TABLE)}, ${col(FACT_TABLE, FACT_CODE_COL)} = ${c} && ${col(FACT_TABLE, FACT_DATE_COL)} >= DATE(YEAR(TODAY()) - 1, 1, 1))
VAR WithYM = ADDCOLUMNS(Fact, "@y", YEAR(${col(FACT_TABLE, FACT_DATE_COL)}), "@m", MONTH(${col(FACT_TABLE, FACT_DATE_COL)}))
RETURN GROUPBY(
  WithYM, [@y], [@m],
  "sales", SUMX(CURRENTGROUP(), ${col(FACT_TABLE, FACT_SALES_COL)}),
  "kg", SUMX(CURRENTGROUP(), ${col(FACT_TABLE, FACT_WEIGHT_COL)})
)`;
}

// Rolling last-3-months window (current month + two full prior months).
function productsQuery(code: string): string {
  const c = daxStr(code);
  return `EVALUATE
SUMMARIZECOLUMNS(
  ${col(FACT_TABLE, FACT_STOCK_CODE_COL)},
  ${col(FACT_TABLE, FACT_DESCRIPTION_COL)},
  FILTER(ALL(${col(FACT_TABLE, FACT_CODE_COL)}), ${col(FACT_TABLE, FACT_CODE_COL)} = ${c}),
  FILTER(ALL(${col(FACT_TABLE, FACT_DATE_COL)}), ${col(FACT_TABLE, FACT_DATE_COL)} > EOMONTH(TODAY(), -3)),
  "kg", SUM(${col(FACT_TABLE, FACT_WEIGHT_COL)}),
  "sales", SUM(${col(FACT_TABLE, FACT_SALES_COL)}),
  "lastSale", MAX(${col(FACT_TABLE, FACT_DATE_COL)})
)
ORDER BY [sales] DESC`;
}

// Line items on the customer's most recent sale date — "what exactly did they
// last order". Grouped by product (a date can span several fact rows), with the
// document/invoice number carried per line so the UI can name the order.
function lastOrderQuery(code: string): string {
  const c = daxStr(code);
  const dateCol = col(FACT_TABLE, FACT_DATE_COL);
  const codeCol = col(FACT_TABLE, FACT_CODE_COL);
  // Mirror the WORKING monthlyQuery: pre-filter the customer's rows to the most
  // recent day in VARs, then GROUPBY + SUMX(CURRENTGROUP()). The previous
  // SUMMARIZECOLUMNS version threw a 400 (DatasetExecuteQueriesError) because
  // its filter argument referenced a computed VAR (LastDate) — Power BI rejects
  // that. GROUPBY over the pre-filtered VAR keeps the customer+day scope intact
  // (an ADDCOLUMNS+CALCULATE rewrite would lose it and sum across all dates).
  // INT() compares by whole day so a time component on the date can't empty it.
  // The grouped Stock Code/Description come back as 'Table'[Col]; cleanPowerBIKey
  // strips them to bare keys the client reads via cell()/r[...].
  return `EVALUATE
VAR Fact = FILTER(${table(FACT_TABLE)}, ${codeCol} = ${c})
VAR LastDay = MAXX(Fact, INT(${dateCol}))
VAR LastRows = FILTER(Fact, INT(${dateCol}) = LastDay)
RETURN
GROUPBY(
  LastRows,
  ${col(FACT_TABLE, FACT_STOCK_CODE_COL)},
  ${col(FACT_TABLE, FACT_DESCRIPTION_COL)},
  "kg", SUMX(CURRENTGROUP(), ${col(FACT_TABLE, FACT_WEIGHT_COL)}),
  "sales", SUMX(CURRENTGROUP(), ${col(FACT_TABLE, FACT_SALES_COL)}),
  "doc", MAXX(CURRENTGROUP(), ${col(FACT_TABLE, FACT_DOCUMENT_COL)}),
  "saleDate", MAXX(CURRENTGROUP(), ${dateCol})
)
ORDER BY [sales] DESC`;
}

// Build the rolling 12-month series (oldest first) with calendar YTD, filling
// months that had no sales with zeros.
function buildMonthly(rows: Record<string, unknown>[]): InsightMonth[] {
  const byKey = new Map<string, { sales: number; kg: number }>();
  for (const r of rows) {
    const y = num(r["@y"]);
    const m = num(r["@m"]);
    if (y && m) byKey.set(`${y}-${m}`, { sales: num(r["sales"]), kg: num(r["kg"]) });
  }

  const now = new Date();
  const out: InsightMonth[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const cell = byKey.get(`${y}-${m}`);
    let ytd = 0;
    for (let mm = 1; mm <= m; mm++) ytd += byKey.get(`${y}-${mm}`)?.sales ?? 0;
    out.push({ year: y, month: m, sales: cell?.sales ?? 0, kg: cell?.kg ?? 0, ytd });
  }
  return out;
}

export async function GET(req: Request) {
  if (!isPowerBIConfigured()) {
    return NextResponse.json({ configured: false, found: false, contacts: [], monthly: [], products: [] });
  }
  const params = new URL(req.url).searchParams;
  const inputCode = params.get("code")?.trim() ?? "";
  const name = params.get("name")?.trim() ?? "";
  const postcode = params.get("postcode")?.trim() ?? "";
  if (!inputCode && !name) {
    return NextResponse.json({ configured: true, found: false, contacts: [], monthly: [], products: [], error: "no_customer_identifier" }, { status: 400 });
  }

  try {
    const warnings: string[] = [];
    // Kick off the freshness lookup early; it's served from a 30-minute
    // in-memory cache, so this usually resolves instantly.
    const refreshedAtPromise = getDatasetLastRefreshTime();
    let code = inputCode;
    let linkSource: CustomerInsights["linkSource"] = code ? "stored_code" : undefined;
    let accountRows = code ? await executePowerBIDaxQuery(accountQuery(code)) : [];
    let a = accountRows[0] ?? {};

    // If the stored link is missing, not found, or produces no fact rows, try
    // resolving the account live from the Power BI customer list.
    if ((!code || num(a["found"]) === 0 || num(a["factRows"]) === 0) && name) {
      const resolved = await resolveFromPowerBI(name, postcode, warnings);
      if (resolved && resolved.code !== code) {
        const resolvedRows = await executePowerBIDaxQuery(accountQuery(resolved.code));
        const resolvedAccount = resolvedRows[0] ?? {};
        const shouldUseResolved =
          !code ||
          num(a["found"]) === 0 ||
          (num(a["factRows"]) === 0 && num(resolvedAccount["factRows"]) > 0);

        if (shouldUseResolved) {
          code = resolved.code;
          linkSource = resolved.source;
          accountRows = resolvedRows;
          a = resolvedAccount;
        }
      } else if (resolved && !linkSource) {
        linkSource = resolved.source;
      }
    }

    const found = num(a["found"]) > 0;
    const [contactRows, monthlyRows, productRows, lastOrderRows] = found && code
      ? await Promise.all([
          optionalQuery(contactsQuery(code), "contacts", warnings),
          executePowerBIDaxQuery(monthlyQuery(code)),
          optionalQuery(productsQuery(code), "products", warnings),
          optionalQuery(lastOrderQuery(code), "lastOrder", warnings),
        ])
      : [[], [], [], []];

    const contacts: InsightContact[] = contactRows
      .map((r) => {
        const flags: string[] = [];
        if (str(r["flagOrder"]).toUpperCase() === "Y") flags.push("Orders");
        if (str(r["flagInvoice"]).toUpperCase() === "Y") flags.push("Invoices");
        if (str(r["flagCredit"]).toUpperCase() === "Y") flags.push("Credits");
        if (str(r["flagAccounts"]).toUpperCase() === "Y") flags.push("Accounts");
        return {
          name: str(r["name"]),
          role: str(r["role"]),
          phone1: str(r["phone1"]),
          phone2: str(r["phone2"]),
          email: str(r["email"]),
          flags,
        };
      })
      .filter((c) => c.name || c.email || c.phone1);

    const products: InsightProduct[] = productRows
      .map((r) => ({
        code: str(r["Stock Code"]),
        description: str(r["Description"]),
        kg: num(r["kg"]),
        sales: num(r["sales"]),
        lastSale: isoDate(r["lastSale"]),
      }))
      .filter((p) => p.code || p.description);

    // Read the grouped columns by suffix so it works whether Power BI returns
    // "Stock Code" or a qualified "Table[Stock Code]".
    const cell = (r: Record<string, unknown>, suffix: string): unknown => {
      const k = Object.keys(r).find((k) => k === suffix || k.endsWith(`[${suffix}]`) || k.endsWith(suffix));
      return k ? r[k] : undefined;
    };
    const lastOrderLines: InsightLastOrderLine[] = lastOrderRows
      .map((r) => ({
        code: str(cell(r, "Stock Code")),
        description: str(cell(r, "Description")),
        kg: num(r["kg"]),
        sales: num(r["sales"]),
      }))
      .filter((l) => l.code || l.description || l.sales || l.kg)
      .sort((x, y) => y.sales - x.sales);
    const lastOrder: InsightLastOrder | undefined = lastOrderLines.length
      ? {
          date: isoDate(lastOrderRows[0]?.["saleDate"]),
          documentNos: Array.from(new Set(lastOrderRows.map((r) => str(r["doc"])).filter(Boolean))),
          total: lastOrderLines.reduce((s, l) => s + l.sales, 0),
          kg: lastOrderLines.reduce((s, l) => s + l.kg, 0),
          lines: lastOrderLines,
        }
      : undefined;

    // Stale = the dataset stopped refreshing (like "LTP Sales Reps Dashboard",
    // frozen 30 Nov 2025). Refresh cadence on live copies is ~3-hourly, so 3
    // silent days is already alarming; when refresh history isn't readable,
    // fall back to the newest fact date (facts run a few days ahead via
    // advance orders, so use a wider window there).
    const datasetRefreshedAt = await refreshedAtPromise;
    const latestDatasetSale = isoDate(a["latestDatasetSale"]);
    const refreshAge = datasetRefreshedAt ? Date.now() - Date.parse(datasetRefreshedAt) : NaN;
    const saleAge = latestDatasetSale ? Date.now() - Date.parse(latestDatasetSale) : NaN;
    const stale = Number.isFinite(refreshAge)
      ? refreshAge > 3 * 86_400_000
      : Number.isFinite(saleAge) && saleAge > 14 * 86_400_000;

    const body: CustomerInsights = {
      configured: true,
      found,
      resolvedCode: code || undefined,
      linkSource,
      account: found
        ? {
            paymentMethod: str(a["paymentMethod"]),
            accountStatus: str(a["accountStatus"]),
            terms: str(a["terms"]),
            priceList: str(a["priceList"]),
            minOrder: a["minOrder"] == null ? null : num(a["minOrder"]),
            adv: a["adv"] == null ? null : num(a["adv"]),
            mainPhone: str(a["mainPhone"]),
            lastRoute: str(a["lastRoute"]),
            customerGroup: str(a["customerGroup"]),
            salesRep: str(a["salesRep"]),
            lastSale: isoDate(a["lastSale"]),
          }
        : undefined,
      contacts,
      monthly: buildMonthly(monthlyRows),
      products,
      lastOrder,
      diagnostics: {
        customerRows: num(a["customerRows"]),
        factRows: num(a["factRows"]),
        totalSales: num(a["totalSales"]),
        latestCustomerSale: isoDate(a["lastSale"]),
        latestDatasetSale,
        datasetRefreshedAt,
        stale,
        warnings: warnings.length ? warnings : undefined,
      },
    };
    return NextResponse.json(body);
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json(
      { configured: true, found: false, contacts: [], monthly: [], products: [], error: message },
      { status: 500 }
    );
  }
}
