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
    summary1: anomalies.length
      ? anomalies.slice(0, 8).map((a) => `• ${a.headline} ${a.detail}`).join("\n")
      : "No significant irregularities detected this week.",
    summary2: opportunities.length
      ? opportunities.slice(0, 8).map((o) => `• ${o.headline} ${o.detail}`).join("\n")
      : "Nothing notable to report this week.",
  });
  if (!apiKey) return fallback();

  try {
    const client = new Anthropic({ apiKey });
    const system = `You write a short weekly digest for the sales team at La Tua Pasta, a London fresh-pasta wholesaler. You're given pre-computed signals (not raw data) from their order history — write it up, don't re-derive it.

Return STRICT JSON only: {"summary1": string, "summary2": string}

- "summary1" ("Irregularities & anomalies — what looks off, and who to call"): the most important lapse/risk signals, prioritised by severity. Direct, specific, actionable — name the account, the number, and what to do. 3-6 short bullet-style points (use "•" or newlines), not a wall of prose. If the input list is empty, say plainly that nothing stood out this week.
- "summary2" ("Value & opportunity insights — state of the business"): the state-of-the-business picture — concentration, who's due to reorder, win-back targets, channel movement, margin. Same style: 3-6 direct points.
- Ground every sentence in the provided signals. Never invent a number, name, or account that isn't in the input.
- Write for a sales manager who has 30 seconds — no preamble, no "in conclusion", no generic filler.`;

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
