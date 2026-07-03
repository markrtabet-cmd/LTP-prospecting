import {
  executePowerBIDaxQuery,
  getDefaultPowerBIDatasetId,
  getPowerBIDataModel,
  isPowerBIWorkspaceConfigured,
  listPowerBIDatasets,
  type PowerBIDataset,
} from "@/lib/powerbi";

export const runtime = "nodejs";

const MAX_STORE_ROWS = 5000;
const SAMPLE_ROWS = 25;

type ToolBody = {
  name?: string;
  input?: Record<string, unknown>;
};

async function resolveDataset(raw: unknown): Promise<{ dataset?: PowerBIDataset; error?: string }> {
  const requested = typeof raw === "string" ? raw.trim() : "";
  let datasets: PowerBIDataset[] | null = null;
  try {
    datasets = await listPowerBIDatasets();
  } catch (e) {
    if (requested) return { dataset: { id: requested, name: requested } };
    const defaultDataset = getDefaultPowerBIDatasetId();
    if (defaultDataset) {
      return { dataset: { id: defaultDataset, name: defaultDataset } };
    }
    const message = e instanceof Error ? e.message : "Couldn't list Power BI datasets";
    return { error: message };
  }

  if (requested) {
    const byId = datasets.find((d) => d.id.toLowerCase() === requested.toLowerCase());
    if (byId) return { dataset: byId };
    const byName = datasets.filter((d) => d.name.toLowerCase() === requested.toLowerCase());
    if (byName.length === 1) return { dataset: byName[0] };
    if (byName.length > 1) {
      return { error: `Multiple Power BI datasets are named "${requested}". Use the dataset id instead.` };
    }
    return { error: `No Power BI dataset matches "${requested}". Call list_datasets first.` };
  }

  const defaultDataset = getDefaultPowerBIDatasetId();
  if (defaultDataset) {
    const configured = datasets.find((d) => d.id.toLowerCase() === defaultDataset.toLowerCase());
    return { dataset: configured ?? { id: defaultDataset, name: defaultDataset } };
  }
  if (datasets.length === 1) return { dataset: datasets[0] };
  if (datasets.length === 0) return { error: "No Power BI datasets were found in this workspace." };
  return { error: `This workspace has ${datasets.length} datasets. Call list_datasets, then specify the dataset id or exact name.` };
}

function columnsFor(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) seen.add(key);
  }
  return Array.from(seen);
}

export async function POST(req: Request) {
  let body: ToolBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  if (!isPowerBIWorkspaceConfigured()) {
    return Response.json({
      error: "powerbi_not_configured",
      message: "Set POWERBI_TENANT_ID, POWERBI_CLIENT_ID, POWERBI_CLIENT_SECRET or username/password, and POWERBI_WORKSPACE_ID.",
    });
  }

  const name = body.name || "";
  const input = body.input ?? {};

  try {
    if (name === "list_datasets") {
      const datasets = await listPowerBIDatasets();
      return Response.json({ datasets, count: datasets.length });
    }

    if (name === "get_data_model") {
      const resolved = await resolveDataset(input.dataset);
      if (resolved.error) return Response.json({ error: "dataset_error", message: resolved.error }, { status: 400 });
      const model = await getPowerBIDataModel(resolved.dataset);
      return Response.json(model);
    }

    if (name === "run_dax_query") {
      const query = String(input.query || "").trim();
      if (!/\bEVALUATE\b/i.test(query)) {
        return Response.json({ error: "bad_dax", message: "DAX query must contain an EVALUATE statement." }, { status: 400 });
      }
      const resolved = await resolveDataset(input.dataset);
      if (resolved.error) return Response.json({ error: "dataset_error", message: resolved.error }, { status: 400 });

      const rows = await executePowerBIDaxQuery(query, resolved.dataset?.id);
      const storedRows = rows.slice(0, MAX_STORE_ROWS);
      const columns = columnsFor(storedRows);
      const resultId = `pbi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      return Response.json({
        result_id: resultId,
        dataset: resolved.dataset,
        columns,
        row_count: rows.length,
        sample: storedRows.slice(0, SAMPLE_ROWS),
        rows: storedRows,
        truncated: rows.length > storedRows.length,
      });
    }

    return Response.json({ error: "unknown_tool", message: `Unknown Power BI tool: ${name}` }, { status: 400 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Power BI tool failed";
    return Response.json({ error: "powerbi_error", message }, { status: 500 });
  }
}
