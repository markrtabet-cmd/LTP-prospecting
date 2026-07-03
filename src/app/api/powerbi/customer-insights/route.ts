import { NextResponse } from "next/server";
import { executePowerBIDaxQuery, isPowerBIConfigured } from "@/lib/powerbi";

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

export interface CustomerInsights {
  configured: boolean;
  found: boolean;
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

function accountQuery(code: string): string {
  const c = daxStr(code);
  return `EVALUATE
VAR Cust = FILTER('v_CoreCustomer', 'v_CoreCustomer'[CustomerAccountCode] = ${c})
VAR Fact = FILTER('F_DAILY', 'F_DAILY'[Cust code] = ${c})
VAR LastRow = TOPN(1, Fact, 'F_DAILY'[Date], DESC)
RETURN ROW(
  "found", COUNTROWS(Cust) + COUNTROWS(LastRow),
  "paymentMethod", MAXX(Cust, 'v_CoreCustomer'[PaymentMethod]),
  "minOrder", MAXX(Cust, 'v_CoreCustomer'[MinimumOrderValue]),
  "priceList", MAXX(Cust, 'v_CoreCustomer'[PriceListCode1]),
  "terms", MAXX(Cust, 'v_CoreCustomer'[DueDateType]),
  "mainPhone", MAXX(Cust, 'v_CoreCustomer'[TelephoneNo]),
  "accountStatus", MAXX(LastRow, 'F_DAILY'[Account Status]),
  "lastRoute", MAXX(LastRow, 'F_DAILY'[Route]),
  "customerGroup", MAXX(LastRow, 'F_DAILY'[Customer Group]),
  "salesRep", MAXX(LastRow, 'F_DAILY'[Sales Rep]),
  "lastSale", MAXX(Fact, 'F_DAILY'[Date]),
  "adv", DIVIDE(SUMX(Fact, 'F_DAILY'[Gross Sales]), COUNTROWS(SUMMARIZE(Fact, 'F_DAILY'[DocumentNo])))
)`;
}

function contactsQuery(code: string): string {
  const c = daxStr(code);
  return `EVALUATE
SELECTCOLUMNS(
  FILTER('v_CoreCustomerContacts', 'v_CoreCustomerContacts'[CustomerAccountCode] = ${c}),
  "name", 'v_CoreCustomerContacts'[ContactName],
  "role", 'v_CoreCustomerContacts'[ContactRole],
  "phone1", 'v_CoreCustomerContacts'[ContactNumber1],
  "phone2", 'v_CoreCustomerContacts'[ContactNumber2],
  "email", 'v_CoreCustomerContacts'[ContactEmail],
  "flagOrder", 'v_CoreCustomerContacts'[Order Confirmation],
  "flagInvoice", 'v_CoreCustomerContacts'[Invoice],
  "flagCredit", 'v_CoreCustomerContacts'[Credit],
  "flagAccounts", 'v_CoreCustomerContacts'[Accounts]
)`;
}

// Fetch monthly aggregates from 1 Jan of LAST year: enough history to compute a
// calendar YTD for every month in the rolling 12-month window. Grouped by
// YEAR/MONTH of the sale date — the model's own [Year]/[Month Number] columns
// are FISCAL (April-start), not calendar.
function monthlyQuery(code: string): string {
  const c = daxStr(code);
  return `EVALUATE
VAR Fact = FILTER('F_DAILY', 'F_DAILY'[Cust code] = ${c} && 'F_DAILY'[Date] >= DATE(YEAR(TODAY()) - 1, 1, 1))
VAR WithYM = ADDCOLUMNS(Fact, "@y", YEAR('F_DAILY'[Date]), "@m", MONTH('F_DAILY'[Date]))
RETURN GROUPBY(
  WithYM, [@y], [@m],
  "sales", SUMX(CURRENTGROUP(), 'F_DAILY'[Gross Sales]),
  "kg", SUMX(CURRENTGROUP(), 'F_DAILY'[Net Weight])
)`;
}

// Rolling last-3-months window (current month + two full prior months).
function productsQuery(code: string): string {
  const c = daxStr(code);
  return `EVALUATE
SUMMARIZECOLUMNS(
  'F_DAILY'[Stock Code],
  'F_DAILY'[Description],
  FILTER(ALL('F_DAILY'[Cust code]), 'F_DAILY'[Cust code] = ${c}),
  FILTER(ALL('F_DAILY'[Date]), 'F_DAILY'[Date] > EOMONTH(TODAY(), -3)),
  "kg", SUM('F_DAILY'[Net Weight]),
  "sales", SUM('F_DAILY'[Gross Sales]),
  "lastSale", MAX('F_DAILY'[Date])
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
  const code = new URL(req.url).searchParams.get("code")?.trim() ?? "";
  if (!code) {
    return NextResponse.json({ configured: true, found: false, contacts: [], monthly: [], products: [], error: "no_code" }, { status: 400 });
  }

  try {
    const [accountRows, contactRows, monthlyRows, productRows] = await Promise.all([
      executePowerBIDaxQuery(accountQuery(code)),
      executePowerBIDaxQuery(contactsQuery(code)),
      executePowerBIDaxQuery(monthlyQuery(code)),
      executePowerBIDaxQuery(productsQuery(code)),
    ]);

    const a = accountRows[0] ?? {};
    const found = num(a["found"]) > 0;

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

    const body: CustomerInsights = {
      configured: true,
      found,
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
