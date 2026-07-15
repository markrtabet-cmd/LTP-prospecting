// Reusable Power BI probe script.
// Usage:
//   node scripts/pbi.mjs dax "EVALUATE ..."   run a DAX query, print rows as JSON
//   node scripts/pbi.mjs get "<path>"         GET https://api.powerbi.com/v1.0/myorg<path>
// Env loaded from the repo's .env.local (no secrets in this file).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENV_PATH = fileURLToPath(new URL("../.env.local", import.meta.url));
const env = {};
for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2];
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[m[1]] = v;
}

const TENANT = env.POWERBI_TENANT_ID;
const WS = env.POWERBI_WORKSPACE_ID;
const DS = process.env.PBI_DS || env.POWERBI_DATASET_ID; // override dataset with PBI_DS=<id>
const API = "https://api.powerbi.com/v1.0/myorg";

async function getToken() {
  const body = new URLSearchParams({
    client_id: env.POWERBI_CLIENT_ID,
    scope: "https://analysis.windows.net/powerbi/api/.default",
    grant_type: "client_credentials",
    client_secret: env.POWERBI_CLIENT_SECRET,
  });
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`auth ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).access_token;
}

async function runDax(token, dax) {
  const res = await fetch(`${API}/groups/${WS}/datasets/${DS}/executeQueries`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ queries: [{ query: dax }], serializerSettings: { includeNulls: true } }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`query ${res.status}: ${text.slice(0, 1200)}`);
  const j = JSON.parse(text);
  const result = j.results?.[0];
  if (result?.error) throw new Error(JSON.stringify(result.error).slice(0, 1200));
  return result?.tables?.[0]?.rows ?? [];
}

const [mode, arg] = process.argv.slice(2);
const token = await getToken();

if (mode === "dax") {
  const rows = await runDax(token, arg);
  console.log(JSON.stringify(rows, null, 1));
  console.error(`-- ${rows.length} rows`);
} else if (mode === "get") {
  const res = await fetch(`${API}${arg}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  try { console.log(JSON.stringify(JSON.parse(text), null, 1)); } catch { console.log(text.slice(0, 2000)); }
} else {
  console.error("usage: node scripts/pbi.mjs dax '<query>' | get '</path>'");
  process.exit(1);
}
