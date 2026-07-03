// Domain vocabulary used to bias speech-to-text towards the words actually
// spoken in LTP sales meetings: the company, its products, its people, and the
// venue being visited. Fed to the transcription model as its prompt (it treats
// the prompt as "words likely to appear") and to the summariser as a glossary
// for correcting near-miss names.

/** Product / trade terms that come up constantly in meetings. */
export const PASTA_TERMS: string[] = [
  "La Tua Pasta",
  "fresh pasta",
  "tagliatelle",
  "pappardelle",
  "fettuccine",
  "linguine",
  "tortelloni",
  "tortellini",
  "ravioli",
  "girasoli",
  "mezzelune",
  "cappellacci",
  "agnolotti",
  "caramelle",
  "fagottini",
  "gnocchi",
  "lasagne",
  "cannelloni",
  "garganelli",
  "strozzapreti",
  "trofie",
  "orecchiette",
  "casarecce",
  "rigatoni",
  "burrata",
  "ricotta",
  "mascarpone",
  "gorgonzola",
  "Parmigiano Reggiano",
  "pecorino",
  "nduja",
  "guanciale",
  "pancetta",
  "porcini",
  "truffle",
  "pesto",
  "pomodoro",
  "ragù",
  "carbonara",
  "amatriciana",
  "cacio e pepe",
  "price list",
  "minimum order",
  "samples",
  "head chef",
  "sous chef",
];

export interface TranscriptionContext {
  /** Venue being visited, if known before recording. */
  venueName?: string | null;
  /** That venue's known contact person (Power BI-synced). */
  contactName?: string | null;
  /** Sales team names — the people most likely doing the talking. */
  repNames?: string[];
  /** Extra likely names, e.g. account managers across the customer base. */
  extraNames?: string[];
}

/**
 * Build the transcription prompt (~max 200 tokens — the API treats it as a
 * style/vocabulary hint, not an instruction). Most-specific names first so
 * they survive if the model truncates the prompt.
 */
export function buildTranscriptionPrompt(ctx: TranscriptionContext = {}): string {
  const parts: string[] = [];
  parts.push(
    "Sales visit notes for La Tua Pasta, a London fresh pasta supplier, spoken by a sales rep after meeting a restaurant client.",
  );
  const names = [
    ctx.venueName,
    ctx.contactName,
    ...(ctx.repNames ?? []),
    ...(ctx.extraNames ?? []),
  ].filter((n): n is string => Boolean(n && n.trim()));
  if (names.length) {
    parts.push(`People and places mentioned: ${dedupe(names).slice(0, 12).join(", ")}.`);
  }
  parts.push(`Common terms: ${PASTA_TERMS.slice(0, 30).join(", ")}.`);
  return parts.join(" ").slice(0, 900);
}

/** Glossary lines for the summariser's name-correction pass. */
export function buildGlossary(ctx: TranscriptionContext = {}): string[] {
  const out: string[] = [];
  if (ctx.venueName) out.push(`Venue: ${ctx.venueName}`);
  if (ctx.contactName) out.push(`Venue contact: ${ctx.contactName}`);
  if (ctx.repNames?.length) out.push(`LTP sales team: ${dedupe(ctx.repNames).join(", ")}`);
  if (ctx.extraNames?.length) out.push(`Other LTP names: ${dedupe(ctx.extraNames).slice(0, 20).join(", ")}`);
  return out;
}

function dedupe(list: string[]): string[] {
  return Array.from(new Set(list.map((s) => s.trim()).filter(Boolean)));
}
