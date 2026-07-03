// Power BI REST API client (server-only).
//
// Power BI does NOT use a simple API key — it authenticates via Microsoft Entra
// ID (Azure AD) OAuth2. This module supports both credential types so you can
// use whichever your admin gives you:
//   • Service principal (recommended): POWERBI_CLIENT_SECRET set  → client_credentials
//   • User account:                    POWERBI_USERNAME/PASSWORD  → password (ROPC)
//
// Customer rows are pulled with the dataset "Execute Queries" endpoint, which
// runs a DAX query against the dataset that holds your customer list.

const AUTHORITY = "https://login.microsoftonline.com";
const SCOPE = "https://analysis.windows.net/powerbi/api/.default";
const API = "https://api.powerbi.com/v1.0/myorg";

function powerBIEnv(name: "TENANT_ID" | "CLIENT_ID" | "CLIENT_SECRET" | "WORKSPACE_ID" | "DATASET_ID"): string | undefined {
  return process.env[`POWERBI_${name}`] || process.env[`PBI_${name}`];
}

export function getDefaultPowerBIDatasetId(): string | undefined {
  return powerBIEnv("DATASET_ID");
}

export function getDefaultPowerBIWorkspaceId(): string | undefined {
  return powerBIEnv("WORKSPACE_ID");
}

export interface PowerBICustomer {
  name: string;
  postcode: string;
  contactName?: string;
  phone?: string;
  email?: string;
  accountManager?: string;
  accountCode?: string;
}

export interface PowerBIDataset {
  id: string;
  name: string;
}

export interface PowerBIModelTable {
  name: string;
  columns: { name: string; type?: string }[];
}

export interface PowerBIModelMeasure {
  name: string;
  table?: string;
  expression?: string;
}

export interface PowerBIDataModel {
  mode: "live";
  dataset?: PowerBIDataset;
  tables: PowerBIModelTable[];
  measures: PowerBIModelMeasure[];
  note?: string;
}

export function isPowerBIConfigured(): boolean {
  const hasApp = Boolean(powerBIEnv("TENANT_ID") && powerBIEnv("CLIENT_ID") && powerBIEnv("DATASET_ID"));
  const hasCreds = Boolean(
    powerBIEnv("CLIENT_SECRET") ||
      (process.env.POWERBI_USERNAME && process.env.POWERBI_PASSWORD)
  );
  return hasApp && hasCreds;
}

export function isPowerBIWorkspaceConfigured(): boolean {
  const hasApp = Boolean(powerBIEnv("TENANT_ID") && powerBIEnv("CLIENT_ID") && powerBIEnv("WORKSPACE_ID"));
  const hasCreds = Boolean(
    powerBIEnv("CLIENT_SECRET") ||
      (process.env.POWERBI_USERNAME && process.env.POWERBI_PASSWORD)
  );
  return hasApp && hasCreds;
}

// The mobile "Sales" panel embeds a live Power BI report (app-owns-data: the
// same Entra service principal used for the customer sync mints a short-lived
// embed token, so field staff need no Power BI licence of their own).
export function isSalesReportConfigured(): boolean {
  const hasApp = Boolean(powerBIEnv("TENANT_ID") && powerBIEnv("CLIENT_ID"));
  const hasCreds = Boolean(
    powerBIEnv("CLIENT_SECRET") ||
      (process.env.POWERBI_USERNAME && process.env.POWERBI_PASSWORD)
  );
  const hasReport = Boolean(
    process.env.POWERBI_SALES_REPORT_ID &&
      (process.env.POWERBI_SALES_WORKSPACE_ID || getDefaultPowerBIWorkspaceId())
  );
  return hasApp && hasCreds && hasReport;
}

async function fetchToken(): Promise<{ token: string; expiresInSec: number }> {
  const tenant = powerBIEnv("TENANT_ID")!;
  const body = new URLSearchParams();
  body.set("client_id", powerBIEnv("CLIENT_ID")!);
  body.set("scope", SCOPE);

  if (process.env.POWERBI_USERNAME && process.env.POWERBI_PASSWORD) {
    // Resource Owner Password Credentials (user account). Fragile with MFA.
    body.set("grant_type", "password");
    body.set("username", process.env.POWERBI_USERNAME);
    body.set("password", process.env.POWERBI_PASSWORD);
    const secret = powerBIEnv("CLIENT_SECRET");
    if (secret) body.set("client_secret", secret);
  } else {
    // Service principal.
    body.set("grant_type", "client_credentials");
    body.set("client_secret", powerBIEnv("CLIENT_SECRET")!);
  }

  const res = await fetch(`${AUTHORITY}/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Power BI auth failed (${res.status}): ${t.slice(0, 300)}`);
  }
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error("Power BI auth returned no access_token");
  return { token: j.access_token, expiresInSec: Number(j.expires_in) || 3600 };
}

// Cache the Entra token for its lifetime (minus a safety margin) and dedupe
// concurrent mints — parallel per-request token requests can trip Entra clock
// skew ("TokenExpired") and add ~500ms latency per Power BI call.
let cachedToken: { token: string; expiresAt: number } | null = null;
let inflightToken: Promise<string> | null = null;

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;
  if (inflightToken) return inflightToken;
  inflightToken = (async () => {
    try {
      const { token, expiresInSec } = await fetchToken();
      cachedToken = { token, expiresAt: Date.now() + Math.max(60, expiresInSec - 300) * 1000 };
      return token;
    } finally {
      inflightToken = null;
    }
  })();
  return inflightToken;
}

// Optional extra columns for the mobile customer "Contact info" panel — each
// is only added to the query if its env var is set, so the sync keeps working
// with just name+postcode until an admin wires these up.
const OPTIONAL_CONTACT_COLUMNS: { alias: string; envVar: string }[] = [
  { alias: "contactName", envVar: "POWERBI_CONTACT_NAME_COLUMN" },
  { alias: "phone", envVar: "POWERBI_CONTACT_PHONE_COLUMN" },
  { alias: "email", envVar: "POWERBI_CONTACT_EMAIL_COLUMN" },
  { alias: "accountManager", envVar: "POWERBI_ACCOUNT_MANAGER_COLUMN" },
  { alias: "accountCode", envVar: "POWERBI_ACCOUNT_CODE_COLUMN" },
];

// Build the DAX that selects customer name + postcode (+ optional contact
// columns). Either supply a full query via POWERBI_CUSTOMERS_DAX, or let us
// build one from table/column names. Columns are aliased so result keys are
// predictable ("name"/"postcode"/"contactName"/"phone"/"email"/"accountManager").
function buildDax(): string {
  if (process.env.POWERBI_CUSTOMERS_DAX) return process.env.POWERBI_CUSTOMERS_DAX;
  const table = process.env.POWERBI_CUSTOMERS_TABLE || "Customers";
  const nameCol = process.env.POWERBI_NAME_COLUMN || "Name";
  const postCol = process.env.POWERBI_POSTCODE_COLUMN || "Postcode";
  const parts = [`"name", '${table}'[${nameCol}]`, `"postcode", '${table}'[${postCol}]`];
  for (const { alias, envVar } of OPTIONAL_CONTACT_COLUMNS) {
    const col = process.env[envVar];
    if (col) parts.push(`"${alias}", '${table}'[${col}]`);
  }
  return `EVALUATE SELECTCOLUMNS('${table}', ${parts.join(", ")})`;
}

async function executeDax(token: string, dax: string): Promise<Record<string, unknown>[]> {
  const dataset = getDefaultPowerBIDatasetId()!;
  const group = getDefaultPowerBIWorkspaceId();
  const url = group
    ? `${API}/groups/${group}/datasets/${dataset}/executeQueries`
    : `${API}/datasets/${dataset}/executeQueries`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ queries: [{ query: dax }], serializerSettings: { includeNulls: true } }),
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Power BI query failed (${res.status}): ${t.slice(0, 400)}`);
  }
  const j = (await res.json()) as {
    results?: { tables?: { rows?: Record<string, unknown>[] }[] }[];
  };
  return j.results?.[0]?.tables?.[0]?.rows ?? [];
}

function cleanPowerBIKey(key: string): string {
  const bracket = key.match(/\[([^\]]+)\]$/);
  if (bracket) return bracket[1];
  return key.replace(/^.*\./, "").trim();
}

function cleanPowerBIRow(row: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) clean[cleanPowerBIKey(key)] = value;
  return clean;
}

export async function listPowerBIDatasets(): Promise<PowerBIDataset[]> {
  if (!isPowerBIWorkspaceConfigured()) {
    throw new Error("Power BI workspace access is not configured");
  }
  const token = await getToken();
  const group = getDefaultPowerBIWorkspaceId()!;
  const res = await fetch(`${API}/groups/${group}/datasets`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Power BI dataset lookup failed (${res.status}): ${t.slice(0, 400)}`);
  }
  const j = (await res.json()) as { value?: { id?: string; name?: string }[] };
  return (j.value ?? [])
    .filter((d): d is { id: string; name: string } => Boolean(d.id && d.name))
    .map((d) => ({ id: d.id, name: d.name }));
}

export async function executePowerBIDaxQuery(dax: string, datasetId?: string): Promise<Record<string, unknown>[]> {
  const dataset = datasetId || getDefaultPowerBIDatasetId();
  const group = getDefaultPowerBIWorkspaceId();
  if (!dataset) throw new Error("No Power BI dataset was specified");
  if (!group) throw new Error("POWERBI_WORKSPACE_ID must be set to query Power BI");

  const token = await getToken();
  const res = await fetch(`${API}/groups/${group}/datasets/${dataset}/executeQueries`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ queries: [{ query: dax }], serializerSettings: { includeNulls: true } }),
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Power BI query failed (${res.status}): ${t.slice(0, 600)}`);
  }
  const j = (await res.json()) as {
    results?: { error?: { message?: string }; tables?: { rows?: Record<string, unknown>[] }[] }[];
  };
  const result = j.results?.[0];
  if (result?.error) throw new Error(result.error.message || "The dataset returned a query error");
  const rows = result?.tables?.[0]?.rows ?? [];
  return rows.map(cleanPowerBIRow);
}

async function safePowerBIQuery(dax: string, datasetId?: string): Promise<Record<string, unknown>[] | null> {
  try {
    return await executePowerBIDaxQuery(dax, datasetId);
  } catch {
    return null;
  }
}

export async function getPowerBIDataModel(dataset?: PowerBIDataset): Promise<PowerBIDataModel> {
  const colRows = await safePowerBIQuery("EVALUATE INFO.VIEW.COLUMNS()", dataset?.id);
  if (!colRows) {
    return {
      mode: "live",
      dataset,
      tables: [],
      measures: [],
      note:
        "Couldn't read this dataset's schema. It may not support INFO functions, or the app may not have Build permission. Ask for table/column names or try a small defensive query.",
    };
  }

  const tables = new Map<string, PowerBIModelTable>();
  for (const row of colRows) {
    const table = String(row.Table || row.TableName || "Table");
    const name = row.Name || row.ColumnName || row.Column;
    if (!name) continue;
    const existing = tables.get(table) ?? { name: table, columns: [] };
    existing.columns.push({ name: String(name), type: row.DataType || row.DataTypeName || row.Type ? String(row.DataType || row.DataTypeName || row.Type) : undefined });
    tables.set(table, existing);
  }

  const measureRows = await safePowerBIQuery("EVALUATE INFO.VIEW.MEASURES()", dataset?.id);
  const measures: PowerBIModelMeasure[] = (measureRows ?? [])
    .map((row) => ({
      name: row.Name || row.MeasureName ? String(row.Name || row.MeasureName) : "",
      table: row.Table || row.TableName ? String(row.Table || row.TableName) : undefined,
      expression: row.Expression ? String(row.Expression) : undefined,
    }))
    .filter((m) => m.name);

  return { mode: "live", dataset, tables: Array.from(tables.values()), measures };
}

// Result keys look like "Customers[Name]" or "[name]" depending on the query;
// flatten to bare lowercase keys so we can read name/postcode robustly.
function normalizeRow(row: Record<string, unknown>): PowerBICustomer {
  const flat: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const key = k.replace(/^.*\[/, "").replace(/\]$/, "").trim().toLowerCase();
    flat[key] = v;
  }
  const str = (v: unknown) => (v == null ? "" : String(v).trim());
  const name = str(flat["name"] ?? flat["customer"] ?? flat["customername"]);
  const postcode = str(flat["postcode"] ?? flat["postalcode"] ?? flat["postal code"] ?? flat["post code"]);
  return {
    name,
    postcode,
    contactName: str(flat["contactname"]) || undefined,
    phone: str(flat["phone"]) || undefined,
    email: str(flat["email"]) || undefined,
    accountManager: str(flat["accountmanager"]) || undefined,
    accountCode: str(flat["accountcode"] ?? flat["customeraccountcode"]) || undefined,
  };
}

export async function fetchPowerBICustomers(): Promise<PowerBICustomer[]> {
  const token = await getToken();
  const rows = await executeDax(token, buildDax());
  return rows.map(normalizeRow).filter((c) => c.name.length > 0);
}

export interface PowerBIEmbedInfo {
  embedUrl: string;
  reportId: string;
  accessToken: string;
  expiration: string;
}

// App-owns-data embed: use the service principal to look up the report's
// embedUrl, then mint a short-lived ("View" only) embed token for it. Called
// fresh per mobile session from src/app/api/powerbi/embed-token/route.ts —
// embed tokens expire in ~1 hour so this can't be precomputed.
export async function getSalesEmbedInfo(): Promise<PowerBIEmbedInfo> {
  const token = await getToken();
  const reportId = process.env.POWERBI_SALES_REPORT_ID!;
  const group = process.env.POWERBI_SALES_WORKSPACE_ID || getDefaultPowerBIWorkspaceId();
  if (!group) {
    throw new Error("POWERBI_SALES_WORKSPACE_ID or POWERBI_WORKSPACE_ID must be set to embed the sales report");
  }

  const reportUrl = `${API}/groups/${group}/reports/${reportId}`;
  const reportRes = await fetch(reportUrl, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!reportRes.ok) {
    const t = await reportRes.text();
    throw new Error(`Power BI report lookup failed (${reportRes.status}): ${t.slice(0, 300)}`);
  }
  const report = (await reportRes.json()) as { embedUrl?: string };
  if (!report.embedUrl) throw new Error("Power BI report lookup returned no embedUrl");

  const tokenRes = await fetch(`${reportUrl}/GenerateToken`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ accessLevel: "View" }),
    cache: "no-store",
  });
  if (!tokenRes.ok) {
    const t = await tokenRes.text();
    throw new Error(`Power BI embed token request failed (${tokenRes.status}): ${t.slice(0, 300)}`);
  }
  const embed = (await tokenRes.json()) as { token?: string; expiration?: string };
  if (!embed.token) throw new Error("Power BI GenerateToken returned no token");

  return { embedUrl: report.embedUrl, reportId, accessToken: embed.token, expiration: embed.expiration ?? "" };
}

// A single Power BI "basic" filter, built server-side so no report schema
// details are exposed to the client bundle. Numeric filterType 1 = Basic per
// the Power BI embed filter schema (avoids depending on the client-only
// powerbi-client package from server code).
export function buildSalesFilters(postcode: string): Record<string, unknown>[] {
  const table = process.env.POWERBI_SALES_FILTER_TABLE;
  const column = process.env.POWERBI_SALES_FILTER_COLUMN;
  if (!table || !column || !postcode) return [];
  return [
    {
      $schema: "http://powerbi.com/product/schema#basic",
      target: { table, column },
      operator: "In",
      values: [postcode],
      filterType: 1,
    },
  ];
}
