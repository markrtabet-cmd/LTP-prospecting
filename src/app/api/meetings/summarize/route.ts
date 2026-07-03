import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { buildGlossary } from "@/lib/visits/glossary";
import { listReps } from "@/lib/users";

export const runtime = "nodejs";
export const maxDuration = 60;

// Turn a meeting transcript/notes into: a tight summary, action points, and —
// crucially for the calendar — any concrete "come back in N weeks / on DATE"
// commitment, which becomes a locked calendar entry the auto-planner works
// around. Names are corrected against the glossary (reps + venue contact)
// rather than trusting raw speech-to-text spellings.

interface SummarizeResult {
  summary: string;
  actionItems: string[];
  followUp: { days: number | null; date: string | null; quote: string | null } | null;
  aiGenerated: boolean;
}

function extractJson(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) return s.slice(first, last + 1);
  return s.trim();
}

/** Keyless fallback: first sentences + todo-looking lines + a relative-time
 * regex so "come back in 2 weeks" still chains into the calendar. */
function fallback(text: string): SummarizeResult {
  const clean = text.replace(/\s+/g, " ").trim();
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  const summary = sentences.slice(0, 3).join(" ").slice(0, 600);
  const actionItems = clean
    .split(/[\n.;]+/)
    .map((s) => s.trim())
    .filter((s) =>
      /\b(follow up|call|send|email|schedule|book|prepare|quote|sample|next|remind|chase)\b/i.test(s),
    )
    .slice(0, 6);

  let followUp: SummarizeResult["followUp"] = null;
  const m = clean.match(
    /\b(?:come back|back|return|visit(?: them)? again|see (?:them|him|her|you)(?: again)?|pop (?:back|in)|call back)\b[^.!?]{0,40}?\bin\s+(?:exactly\s+)?(a|one|two|three|four|five|six|\d+)\s+(day|week|month)s?\b/i,
  );
  if (m) {
    const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
    const n = words[m[1].toLowerCase()] ?? parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    const days = unit === "day" ? n : unit === "week" ? n * 7 : n * 30;
    if (Number.isFinite(days) && days > 0) followUp = { days, date: null, quote: m[0] };
  }

  return { summary: summary || clean.slice(0, 600), actionItems, followUp, aiGenerated: false };
}

export async function POST(req: Request) {
  let body: { text?: string; venueName?: string; contactName?: string; meetingDate?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  const text = (body.text ?? "").trim();
  if (!text) return NextResponse.json({ ok: false, error: "empty_text" }, { status: 400 });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: true, ...fallback(text) });
  }

  try {
    const reps = await listReps();
    const glossary = buildGlossary({
      venueName: body.venueName,
      contactName: body.contactName,
      repNames: reps.map((r) => r.name),
      extraNames: reps.flatMap((r) => r.aliases ?? []),
    });

    const system = `You turn a La Tua Pasta (London fresh-pasta supplier) sales rep's meeting transcript or notes into a concise record.
Return STRICT JSON only:
{"summary": string, "actionItems": string[], "followUp": {"days": number|null, "date": "YYYY-MM-DD"|null, "quote": string}|null}

Rules:
- "summary": 2-4 short sentences — what was discussed, decisions, the client's situation and interest. Written for a colleague; max ~600 characters.
- "actionItems": concrete follow-ups the rep must do, short imperative phrases. Empty array if none.
- "followUp": ONLY when the meeting contains a concrete commitment to return/meet again at a specific time (e.g. "come back in exactly two weeks", "see you on the 14th", "call me next month"). Give "days" (relative to the meeting date) OR "date" (absolute), plus the exact "quote". Vague intentions ("catch up soon", "at some point") are null.
- Speech-to-text may misspell names. Correct people/venue/product names against this glossary and use the corrected spellings everywhere:
${glossary.map((g) => `  ${g}`).join("\n") || "  (no glossary provided)"}
- Do not invent content that isn't in the notes. No text outside the JSON.`;

    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-opus-4-8",
      max_tokens: 800,
      system,
      messages: [
        {
          role: "user",
          content: `Meeting date: ${body.meetingDate ?? new Date().toISOString().slice(0, 10)}\nMeeting notes / transcript:\n\n${text.slice(0, 24000)}`,
        },
      ],
    });

    const block = resp.content.find((b) => b.type === "text");
    const out = block && block.type === "text" ? block.text : "";
    const parsed = JSON.parse(extractJson(out)) as Partial<SummarizeResult>;

    const followUpRaw = parsed.followUp as SummarizeResult["followUp"] | null | undefined;
    const result: SummarizeResult = {
      summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 700) : "",
      actionItems: Array.isArray(parsed.actionItems)
        ? parsed.actionItems.filter((x): x is string => typeof x === "string").slice(0, 10)
        : [],
      followUp:
        followUpRaw && (followUpRaw.days != null || followUpRaw.date)
          ? {
              days: typeof followUpRaw.days === "number" ? followUpRaw.days : null,
              date: typeof followUpRaw.date === "string" ? followUpRaw.date : null,
              quote: typeof followUpRaw.quote === "string" ? followUpRaw.quote : null,
            }
          : null,
      aiGenerated: true,
    };
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("AI summary failed, using fallback:", e);
    return NextResponse.json({ ok: true, ...fallback(text) });
  }
}
