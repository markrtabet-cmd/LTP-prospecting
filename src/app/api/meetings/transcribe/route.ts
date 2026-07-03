import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase";
import { downloadMedia, isValidMediaPath, transcriptPathFor, uploadText } from "@/lib/meeting-media";
import { buildTranscriptionPrompt } from "@/lib/visits/glossary";
import { listReps } from "@/lib/users";

export const runtime = "nodejs";
// Whisper/4o on a long recording comfortably exceeds the default timeout.
export const maxDuration = 120;

// Server-side transcription of an already-uploaded recording. Accuracy is the
// point here, so the request is biased with domain context: it's a pasta
// company, these people (reps + the venue's contact) are probably the ones
// being talked about, and these product terms come up constantly.
export async function POST(req: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: false, configured: false });
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({
      ok: false,
      error: "Server transcription isn't configured (no OPENAI_API_KEY) — the live transcript / typed notes still work.",
    });
  }

  let body: {
    path?: string;
    venueId?: string;
    meetingId?: string;
    venueName?: string;
    contactName?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  const path = body.path ?? "";
  if (!isValidMediaPath(path) || !path.startsWith("audio/")) {
    return NextResponse.json({ ok: false, error: "bad_path" }, { status: 400 });
  }

  try {
    const audio = await downloadMedia(path);

    const reps = await listReps();
    const prompt = buildTranscriptionPrompt({
      venueName: body.venueName,
      contactName: body.contactName,
      repNames: reps.map((r) => r.name),
      extraNames: reps.flatMap((r) => r.aliases ?? []),
    });

    // gpt-4o-transcribe is markedly more accurate than whisper-1 and takes the
    // same vocabulary-bias prompt; the env var can still pin a specific model.
    const model = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe";
    const ext = path.split(".").pop() || "webm";
    const form = new FormData();
    form.append("file", audio, `recording.${ext}`);
    form.append("model", model);
    form.append("prompt", prompt);
    form.append("language", "en");

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!resp.ok) {
      const detail = await resp.text();
      console.error("Transcription failed:", detail);
      return NextResponse.json(
        { ok: false, error: `Transcription failed (${resp.status}).` },
        { status: 502 },
      );
    }
    const data = (await resp.json()) as { text?: string };
    const transcript = (data.text ?? "").trim();
    if (!transcript) return NextResponse.json({ ok: false, error: "empty_transcript" });

    // Keep the full transcript in Storage next to the audio — the meetings
    // table only ever stores the path.
    let transcriptPath: string | null = null;
    if (body.venueId && body.meetingId) {
      transcriptPath = transcriptPathFor(body.venueId, body.meetingId);
      await uploadText(transcriptPath, transcript).catch(() => {
        transcriptPath = null;
      });
    }

    return NextResponse.json({ ok: true, transcript, transcriptPath });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
