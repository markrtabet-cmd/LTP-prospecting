// Customer sector (Power BI's F_DAILY[Market] column) — the channel a customer
// trades in. Shared by the server sync (which stamps it onto each customer) and
// the client filters (Customers page + map "hide irrelevant sectors" toggle),
// so both agree on the canonical label and on which sectors sales reps care about.

// The sectors reps prospect/serve — everything else (internal LTP retail, export,
// supermarket, chains, unclassified) is hidden behind a toggle.
export const RELEVANT_SECTORS = [
  "Caterers",
  "Clubs",
  "Delis",
  "Gastropubs",
  "Hotels",
  "Independent restaurant",
  "Italian restaurant",
  "Stalls & takeaways",
  "Airlines",
  "Distributors",
  "Food halls",
  "Online",
  "Fishmongers",
] as const;

const RELEVANT_SET = new Set<string>(RELEVANT_SECTORS);

// Raw Power BI Market value (upper-cased in the dataset) → clean display label.
const RAW_TO_LABEL: Record<string, string> = {
  "CATERERS": "Caterers",
  "CLUBS": "Clubs",
  "DELIS": "Delis",
  "GASTROPUBS": "Gastropubs",
  "HOTELS": "Hotels",
  "INDEPENDENT RESTAURANT": "Independent restaurant",
  "ITALIAN RESTAURANT": "Italian restaurant",
  "STALLS & TAKEAWAY": "Stalls & takeaways",
  "STALLS & TAKEAWAYS": "Stalls & takeaways",
  "AIRLINES": "Airlines",
  "DISTRIBUTORS": "Distributors",
  "FOODHALLS": "Food halls",
  "FOOD HALLS": "Food halls",
  "ONLINE": "Online",
  "FISHMONGERS": "Fishmongers",
  // Non-target channels — kept as readable labels so the toggle can name them,
  // but excluded from RELEVANT_SECTORS.
  "LA TUA PASTA ONLINE": "LTP online",
  "LA TUA PASTA RESTAURANT": "LTP restaurant",
  "DIRECT RETAIL": "Direct retail",
  "EXPORT": "Export",
  "SUPERMARKET": "Supermarket",
  "CHAINS": "Chains",
  "NONE": "Unclassified",
};

/** Normalise a raw Power BI Market value to a clean sector label (or undefined). */
export function canonicalSector(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const key = raw.trim().toUpperCase();
  if (!key || key === "(BLANK)") return undefined;
  return RAW_TO_LABEL[key] ?? raw.trim();
}

/**
 * Whether a customer with this sector should be shown when the "relevant
 * sectors only" filter is ON. Unknown/missing sectors are treated as relevant
 * so a customer is never hidden merely because its sector didn't sync.
 */
export function isRelevantSector(sector?: string | null): boolean {
  if (!sector) return true;
  return RELEVANT_SET.has(sector);
}
