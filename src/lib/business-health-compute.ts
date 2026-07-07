import Anthropic from "@anthropic-ai/sdk";
import {
  fetchCategoryWindows,
  fetchChannelMonthly,
  fetchCustomerMeta,
  fetchCustomerMonthly,
  fetchOrderFrequency,
} from "./business-health-data";
import {
  computeChannelTrend,
  computeRevenueConcentration,
  detectBasketShrinkage,
  detectMarginOutliers,
  detectOrderFrequencyDrops,
  detectProductMixShifts,
  detectVanishedNewAccounts,
  buildReorderDueList,
  rankWinBackCandidates,
  type AnomalySignal,
  type CustomerMeta,
  type OpportunitySignal,
} from "./business-health";

export const BUSINESS_HEALTH_TABLE = "ltp_business_health";
export const BUSINESS_HEALTH_ROW_ID = "latest";

export interface BusinessHealthResult {
  computedAt: string;
  summary1: string;
  summary2: string;
  anomalies: AnomalySignal[];
  opportunities: OpportunitySignal[];
}

function extractJson(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) return s.slice(first, last + 1);
  return s.trim();
}

async function writeSummaries(anomalies: AnomalySignal[], opportunities: OpportunitySignal[]): Promise<{ summary1: string; summary2: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const fallback = () => ({
    summary1: opportunities.length
      ? opportunities.slice(0, 8).map((o) => `• ${o.headline} ${o.detail}`).join("\n")
      : "Nothing pressing to chase this week — you're on top of things.",
    summary2: anomalies.length
      ? anomalies.slice(0, 8).map((a) => `• ${a.headline} ${a.detail}`).join("\n")
      : "A steady week — nothing notable to flag.",
  });
  if (!apiKey) return fallback();

  try {
    const client = new Anthropic({ apiKey });
    const system = `You write a short, friendly weekly digest for a sales rep at La Tua Pasta, a London fresh-pasta wholesaler. You're given pre-computed signals (not raw data) from their order history — write them up in plain English, don't re-derive them.

Return STRICT JSON only: {"summary1": string, "summary2": string}

Keep everything SMALL and SPECIFIC — individual accounts and concrete things to do. Never write big-picture "state of the business" summaries, headline totals, or aggregate percentages. Each point is one named account (or one clear thing) and why it's worth a moment.

- "summary1" ("Worth a closer look"): 3-6 specific accounts to act on this week — someone to check in on, a reorder to chase, an account to win back, a new customer to welcome. Name the account and the reason, phrased as a friendly nudge you could act on today.
- "summary2" ("What's shifting"): 3-5 small, specific movements worth knowing — a product an account has picked up or dropped, someone ordering more or less than usual. Concrete and per-account, not an aggregate overview.
- Plain words, no jargon, no ALL-CAPS, no metrics-speak: say "their orders have slowed" not "MoM volume -32%". You may soften a number into words, but never invent a number, name, or account that isn't in the input.
- If there's nothing notable, say so warmly rather than padding.
- Write for a busy person with 30 seconds — no preamble, no "in conclusion", no filler.`;

    const resp = await client.messages.create({
      model: process.env.AI_MODEL || "claude-opus-4-8",
      max_tokens: 1200,
      system,
      messages: [
        {
          role: "user",
          content: `Anomaly signals (${anomalies.length} total, most severe first):\n${JSON.stringify(anomalies.slice(0, 20), null, 2)}\n\nOpportunity signals (${opportunities.length} total):\n${JSON.stringify(opportunities.slice(0, 20), null, 2)}`,
        },
      ],
    });
    const block = resp.content.find((b) => b.type === "text");
    const raw = block && block.type === "text" ? block.text : "";
    const parsed = JSON.parse(extractJson(raw)) as { summary1?: string; summary2?: string };
    if (typeof parsed.summary1 === "string" && typeof parsed.summary2 === "string") {
      return { summary1: parsed.summary1, summary2: parsed.summary2 };
    }
    return fallback();
  } catch {
    return fallback();
  }
}

/** Fetch every bulk shape, run all detectors, and have Claude write the two
 * prose summaries. Pure orchestration — no Supabase write here, callers
 * decide where the result is persisted. */
export async function computeBusinessHealth(): Promise<BusinessHealthResult> {
  const today = new Date();
  const [monthly, meta, orderFreq, categoryWindows, channelMonthly] = await Promise.all([
    fetchCustomerMonthly(),
    fetchCustomerMeta(),
    fetchOrderFrequency(),
    fetchCategoryWindows(),
    fetchChannelMonthly(),
  ]);
  const metaByCode = new Map<string, CustomerMeta>(meta.map((m) => [m.custCode, m]));

  const anomalies: AnomalySignal[] = [
    ...detectOrderFrequencyDrops(orderFreq, metaByCode),
    ...detectBasketShrinkage(monthly, metaByCode),
    ...detectProductMixShifts(categoryWindows, metaByCode),
    ...detectVanishedNewAccounts(monthly, metaByCode, today),
  ].sort((a, b) => (b.severity === "high" ? 1 : 0) - (a.severity === "high" ? 1 : 0));

  const opportunities: OpportunitySignal[] = [
    computeRevenueConcentration(monthly, metaByCode),
    ...buildReorderDueList(orderFreq, metaByCode),
    ...rankWinBackCandidates(monthly, metaByCode, today),
    ...computeChannelTrend(channelMonthly),
    ...detectMarginOutliers(monthly, metaByCode),
  ];

  const { summary1, summary2 } = await writeSummaries(anomalies, opportunities);

  return {
    computedAt: new Date().toISOString(),
    summary1,
    summary2,
    anomalies: anomalies.slice(0, 30),
    opportunities: opportunities.slice(0, 30),
  };
}
