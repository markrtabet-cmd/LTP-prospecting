import Anthropic from "@anthropic-ai/sdk";

// Web-scan for newly opened / soon-to-open London restaurants using Claude's
// server-side web_search tool. Returns a clean JSON array the client turns into
// "new opening" venues.

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

function buildPrompt(area?: string) {
  const where = area ? `in/around ${area}, London` : "across London";
  return `Search the web for RESTAURANTS that have recently opened, or are opening soon, ${where} (focus on the last ~8 weeks and upcoming openings). Use reputable London food/opening sources such as Hot Dinners, Eater London, SquareMeal, Time Out London, The Infatuation, and CODE Hospitality.

Return ONLY a JSON array (no prose, no markdown fences) of up to 12 objects, each with exactly these keys:
- "name": the restaurant name
- "area": the London neighbourhood or borough (e.g. "Soho", "Shoreditch", "Borough")
- "cuisine": best guess of cuisine (e.g. "Italian", "Modern European", "Japanese / Sushi")
- "openingDate": approximate, e.g. "opened June 2026" or "opening July 2026"
- "evidence": one short phrase citing the source, e.g. "Eater London new-openings, Jun 2026"
- "url": the source article URL if available, else ""

Only include genuine, specific restaurants you found evidence for. If you cannot find any, return [].`;
}

function extractJsonArray(text: string): unknown[] {
  if (!text) return [];
  // 1) whole text is JSON
  try {
    const whole = JSON.parse(text.trim());
    if (Array.isArray(whole)) return whole;
  } catch {
    /* fall through */
  }
  // 2) fenced ```json block
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      const inner = JSON.parse(fence[1].trim());
      if (Array.isArray(inner)) return inner;
    } catch {
      /* fall through */
    }
  }
  // 3) first '[' to last ']'
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const sliced = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(sliced)) return sliced;
    } catch {
      /* fall through */
    }
  }
  return [];
}

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "no_api_key" });
  }

  let area: string | undefined;
  try {
    const body = await req.json();
    area = body?.area ? String(body.area) : undefined;
  } catch {
    /* no body is fine */
  }

  try {
    const client = new Anthropic();
    // web_search_20260209 is a server-side tool (Opus 4.8 supports it). Cast the
    // params because this SDK version's typings may not include that tool variant.
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: buildPrompt(area) }];

    let best: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      const params = {
        model: MODEL,
        max_tokens: 2048,
        // Basic web search variant — works across all models (incl. Haiku), no
        // programmatic-tool-calling requirement.
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
        messages,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      const response = await client.messages.create(params);

      const textNow = response.content
        .filter((b) => b.type === "text")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((b) => (b as any).text as string)
        .join("\n");
      const parsed = extractJsonArray(textNow);
      if (parsed.length > best.length) best = parsed; // keep the richest array seen

      if (response.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: response.content });
        continue; // resume the server-tool loop
      }
      break;
    }

    return Response.json({ openings: best });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    return Response.json({ error: "api_error", message }, { status: 500 });
  }
}
