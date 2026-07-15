import Anthropic from "@anthropic-ai/sdk";

// Generates a high-quality, tailored B2B outreach email for one venue.

export const runtime = "nodejs";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";

const SYSTEM = `You are a senior B2B sales copywriter for "La Tua Pasta" (LTP), a London-based pastificio that makes fresh pasta overnight in London and supplies it to restaurants, hotels, caterers, delis and other food-service businesses (filled pasta, gnocchi, long pasta, seasonal specials; sample boxes and trade catalogues available).

Write ONE cold outreach email from LTP to the venue described. Rules:
- Tone: warm, professional, confident, peer-to-peer chef/trade — never gushing or salesy.
- Personalise with a SPECIFIC, genuine hook from the venue's data: its cuisine, its neighbourhood, or that it has just opened / is opening soon. If it just opened, congratulate briefly and naturally.
- Structure: 3 short paragraphs max, ~90–130 words total. (1) the hook + who LTP is in one line, (2) what LTP could do for them tied to their menu/cuisine, (3) a soft, low-friction CTA (offer a free sample box or trade catalogue; ask if they're open to a quick look).
- UK English. No emojis. No clichés ("I hope this email finds you well", "cutting through the noise", "game-changer"). No fake urgency. Do not invent facts beyond the data given (no made-up awards, chef names, or dishes).
- Do NOT include any sign-off, name or signature — the app appends the sender's real signature afterwards. End the body with only a final line: "Reply STOP to opt out."
- Subject: short and specific (max ~55 chars), referencing the venue or fresh pasta; no clickbait, no ALL CAPS.

Return the result as JSON.`;

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "no_api_key" });
  }

  let r: Record<string, unknown> = {};
  try {
    const body = await req.json();
    r = body?.restaurant ?? {};
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  const facts = [
    `Name: ${r.name ?? "(unknown)"}`,
    r.cuisineType ? `Cuisine: ${r.cuisineType}` : "",
    r.borough ? `Area: ${r.borough}` : "",
    r.priceLabel ? `Price point: ${r.priceLabel}` : "",
    r.openingStatus === "new_this_week" ? "Status: newly opened (this week)" : r.openingStatus === "opening_soon" ? "Status: opening soon" : "",
    r.recommended ? "This is a strong fit for premium fresh pasta." : "",
  ].filter(Boolean).join("\n");

  try {
    const client = new Anthropic();
    const params = {
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: "user", content: `Write the outreach email for this venue:\n${facts}` }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              subject: { type: "string" },
              body: { type: "string" },
            },
            required: ["subject", "body"],
          },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const response = await client.messages.create(params);
    const text = response.content
      .filter((b) => b.type === "text")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((b) => (b as any).text as string)
      .join("");
    let subject = "";
    let outBody = "";
    try {
      const parsed = JSON.parse(text);
      subject = String(parsed.subject ?? "");
      outBody = String(parsed.body ?? "");
    } catch {
      outBody = text;
    }
    if (!subject && !outBody) return Response.json({ error: "empty" }, { status: 500 });
    return Response.json({ subject, body: outBody });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    return Response.json({ error: "api_error", message }, { status: 500 });
  }
}
