import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { buildGlossary } from "@/lib/visits/glossary";
import { listReps } from "@/lib/users";

export const runtime = "nodejs";
export const maxDuration = 60;

// Turn a meeting transcript/notes into: a tight summary, action points, and —
// crucially for the calendar — anything that should update the record on its
// own:
//   - followUp:        a concrete "come back in N weeks / on DATE" commitment
//                       -> a locked calendar entry (src/lib/visits/followup.ts).
//   - emailNeeded:      the customer needs something sent (samples, a price
//                       list, info) -> a ready-to-send email draft.
//   - frequencyChange:  an explicit new visit cadence ("every 2 months instead
//                       of 3") -> updates the venue's visit rhythm.
// All three are shown to the rep as an editable, removable card before they're
// applied on save (RecordMeetingSheet) — nothing here writes anything itself.
// Names are corrected against the glossary (reps + venue contact) rather than
// trusting raw speech-to-text spellings.

interface SummarizeResult {
  summary: string;
  actionItems: string[];
  followUp: { days: number | null; date: string | null; quote: string | null } | null;
  emailNeeded: { subject: string; body: string; reason: string | null } | null;
  frequencyChange: { newIntervalDays: number | null; quote: string | null } | null;
  // The customer PLACED an order during the meeting -> a ready-to-send email to
  // customer service with the products & quantities (RecordMeetingSheet).
  orderPlaced: { items: string; quote: string | null } | null;
  // How the pursuit of a PROSPECT is going, judged from the notes — colours the
  // Lead badge on the leads page (see Restaurant.noteSentiment). null when the
  // notes are genuinely unclear or this is an existing-customer meeting.
  sentiment: "good" | "not_good" | null;
  sentimentReason: string | null;
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

const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, month: 30 };
const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, twelve: 12 };

/** Keyless fallback: first sentences + todo-looking lines + regexes for the
 * follow-up date, a sample/info request, and an explicit cadence change — all
 * narrower than the AI path, but not silently absent when there's no API key. */
function fallback(text: string, venueName?: string): SummarizeResult {
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
  const fm = clean.match(
    /\b(?:come back|back|return|visit(?: them)? again|see (?:them|him|her|you)(?: again)?|pop (?:back|in)|call back)\b[^.!?]{0,40}?\bin\s+(?:exactly\s+)?(a|one|two|three|four|five|six|\d+)\s+(day|week|month)s?\b/i,
  );
  if (fm) {
    const n = WORD_NUM[fm[1].toLowerCase()] ?? parseInt(fm[1], 10);
    const unit = fm[2].toLowerCase();
    const days = unit === "day" ? n : unit === "week" ? n * 7 : n * 30;
    if (Number.isFinite(days) && days > 0) followUp = { days, date: null, quote: fm[0] };
  }

  let emailNeeded: SummarizeResult["emailNeeded"] = null;
  const em = clean.match(/[^.!?]*\b(sample|catalogue|price list|brochure|info(?:rmation)?)\b[^.!?]*[.!?]?/i);
  if (em) {
    const name = venueName || "there";
    emailNeeded = {
      subject: `Following up from our visit`,
      body: `Hi,\n\nGreat catching up today. As discussed, I'll get this sent over: ${em[0].trim()}\n\nAny questions in the meantime, just let me know.\n`,
      reason: em[0].trim(),
    };
    void name;
  }

  let frequencyChange: SummarizeResult["frequencyChange"] = null;
  const cm = clean.match(
    /\bevery\s+(a|one|two|three|four|five|six|twelve|\d+)\s+(day|week|month)s?\b[^.!?]{0,30}\b(instead|now|going forward|from now on)\b/i,
  );
  if (cm) {
    const n = WORD_NUM[cm[1].toLowerCase()] ?? parseInt(cm[1], 10);
    const unit = cm[2].toLowerCase();
    const days = UNIT_DAYS[unit] * n;
    if (Number.isFinite(days) && days > 0) frequencyChange = { newIntervalDays: days, quote: cm[0] };
  }

  // An order placed during the visit — needs an order-with-quantities cue, so a
  // mere mention of "order" or a sample request doesn't fire.
  let orderPlaced: SummarizeResult["orderPlaced"] = null;
  const om = clean.match(
    /[^.!?]*\b(order|re-?order|put me down for|i'?ll take|i'?ll have|same as last (?:week|time))\b[^.!?]*[.!?]?/i,
  );
  if (om && /\b(kg|kilo|box|boxes|tray|trays|case|cases|pack|packs|unit|units|portion|portions|\d+)\b/i.test(om[0])) {
    orderPlaced = { items: om[0].trim(), quote: om[0].trim() };
  }

  // Keyword read on how the pursuit is going. Negative first: "not interested"
  // must not match the positive /interested/ pattern.
  let sentiment: SummarizeResult["sentiment"] = null;
  let sentimentReason: string | null = null;
  const bad = clean.match(/\b(not interested|no answer|already (?:have|use|with)|too expensive|rude|closed|don'?t call)\b/i);
  const good = clean.match(/\b(interested|loved|keen|sample|quote|order|come back|follow up)\b/i);
  if (bad) {
    sentiment = "not_good";
    sentimentReason = bad[0];
  } else if (good) {
    sentiment = "good";
    sentimentReason = good[0];
  }

  return { summary: summary || clean.slice(0, 600), actionItems, followUp, emailNeeded, frequencyChange, orderPlaced, sentiment, sentimentReason, aiGenerated: false };
}

export async function POST(req: Request) {
  // mode "note": the text is a prospect's typed contact-log notes rather than a
  // meeting transcript — same AI/prompt, mainly there so the `sentiment` verdict
  // can be recomputed cheaply after every note write (see src/lib/note-sentiment.ts).
  let body: { text?: string; venueName?: string; contactName?: string; meetingDate?: string; mode?: "note" };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  const text = (body.text ?? "").trim();
  if (!text) return NextResponse.json({ ok: false, error: "empty_text" }, { status: 400 });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: true, ...fallback(text, body.venueName) });
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
{"summary": string, "actionItems": string[], "followUp": {"days": number|null, "date": "YYYY-MM-DD"|null, "quote": string}|null, "emailNeeded": {"subject": string, "body": string, "reason": string}|null, "frequencyChange": {"newIntervalDays": number|null, "quote": string}|null, "orderPlaced": {"items": string, "quote": string}|null, "sentiment": "good"|"not_good"|null, "sentimentReason": string|null}

Rules:
- "summary": 2-4 short sentences — what was discussed, decisions, the client's situation and interest. Written for a colleague; max ~600 characters.
- "actionItems": concrete follow-ups the rep must do, short imperative phrases. Empty array if none.
- "followUp": ONLY when the meeting contains a concrete commitment to return/meet again at a specific time (e.g. "come back in exactly two weeks", "see you on the 14th", "call me next month"). Give "days" (relative to the meeting date) OR "date" (absolute), plus the exact "quote". Vague intentions ("catch up soon", "at some point") are null.
- "emailNeeded": ONLY when the customer needs something SENT to them that an email would naturally fulfil (samples, a price list, a catalogue, product info, a quote). Draft a short (~80-120 word), warm, specific follow-up email FROM the rep referencing what was discussed — not a cold pitch, this is an existing relationship. Do NOT include any sign-off, name or signature — the app appends the sender's real signature afterwards. "reason" is a one-line note on why (e.g. "asked for a sample box of the seasonal specials"). Null if nothing needs sending.
- "frequencyChange": ONLY when the rep or customer explicitly states a NEW ongoing visit cadence (e.g. "let's do every 2 months instead of 3", "monthly from now on", "quarterly is enough now"). Give "newIntervalDays" (approximate: weekly=7, fortnightly=14, monthly=30, quarterly=91) and the exact "quote". A one-off reschedule of a single visit is NOT a frequency change — null unless the ongoing rhythm itself is being changed.
- "orderPlaced": ONLY when the customer actually PLACES or RE-ORDERS product during the visit (e.g. "put me down for 10kg of the beef ravioli", "same as last week plus 5 trays of lasagne", "I'll take a box of the gnocchi"). "items" = the products and quantities as a short plain-text list, one per line where there are several; "quote" = the exact words. This becomes an order sent to customer service, so only fire on a concrete order — mere interest, a sample request, or "I might order soon" is NOT an order (null).
- "sentiment": for a PROSPECT (not an existing customer), judge how the pursuit is going from these notes: "good" (interested, wants samples/quote, meeting booked, warm) or "not_good" (not interested, already has a supplier, unresponsive, brushed off, gone cold). null if genuinely unclear or this is an existing customer. "sentimentReason" is a one-line justification (e.g. "asked for samples and a price list"); null when sentiment is null.
- Speech-to-text may misspell names. Correct people/venue/product names against this glossary and use the corrected spellings everywhere:
${glossary.map((g) => `  ${g}`).join("\n") || "  (no glossary provided)"}
- Do not invent content that isn't in the notes. No text outside the JSON.`;

    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      // Prod env naming is inconsistent (business-health uses AI_MODEL, the
      // older routes ANTHROPIC_MODEL) — honour whichever is set.
      model: process.env.AI_MODEL || process.env.ANTHROPIC_MODEL || "claude-opus-4-8",
      max_tokens: 1100,
      system,
      messages: [
        {
          role: "user",
          content: `Meeting date: ${body.meetingDate ?? new Date().toISOString().slice(0, 10)}\n${body.mode === "note" ? "Rep contact-log notes on this prospect (oldest first)" : "Meeting notes / transcript"}:\n\n${text.slice(0, 24000)}`,
        },
      ],
    });

    const block = resp.content.find((b) => b.type === "text");
    const out = block && block.type === "text" ? block.text : "";
    const parsed = JSON.parse(extractJson(out)) as Partial<SummarizeResult>;

    const followUpRaw = parsed.followUp as SummarizeResult["followUp"] | null | undefined;
    const emailRaw = parsed.emailNeeded as SummarizeResult["emailNeeded"] | null | undefined;
    const freqRaw = parsed.frequencyChange as SummarizeResult["frequencyChange"] | null | undefined;
    const orderRaw = parsed.orderPlaced as SummarizeResult["orderPlaced"] | null | undefined;

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
      emailNeeded:
        emailRaw && typeof emailRaw.subject === "string" && typeof emailRaw.body === "string"
          ? {
              subject: emailRaw.subject.slice(0, 150),
              body: emailRaw.body.slice(0, 2000),
              reason: typeof emailRaw.reason === "string" ? emailRaw.reason.slice(0, 200) : null,
            }
          : null,
      frequencyChange:
        freqRaw && typeof freqRaw.newIntervalDays === "number" && freqRaw.newIntervalDays > 0
          ? {
              newIntervalDays: Math.round(freqRaw.newIntervalDays),
              quote: typeof freqRaw.quote === "string" ? freqRaw.quote : null,
            }
          : null,
      orderPlaced:
        orderRaw && typeof orderRaw.items === "string" && orderRaw.items.trim()
          ? {
              items: orderRaw.items.slice(0, 1500),
              quote: typeof orderRaw.quote === "string" ? orderRaw.quote : null,
            }
          : null,
      sentiment: parsed.sentiment === "good" || parsed.sentiment === "not_good" ? parsed.sentiment : null,
      sentimentReason:
        (parsed.sentiment === "good" || parsed.sentiment === "not_good") && typeof parsed.sentimentReason === "string"
          ? parsed.sentimentReason.slice(0, 200)
          : null,
      aiGenerated: true,
    };
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("AI summary failed, using fallback:", e);
    return NextResponse.json({ ok: true, ...fallback(text, body.venueName) });
  }
}
