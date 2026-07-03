import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase";
import { audioPathFor, createUploadUrl, MAX_AUDIO_BYTES } from "@/lib/meeting-media";

export const runtime = "nodejs";

// Signed direct-to-Storage upload. The browser PUTs the audio straight to
// Supabase — routing the file through this server would hit Vercel's ~4.5 MB
// request-body cap on real recordings.
export async function POST(req: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: false, configured: false }, { status: 200 });
  }
  let body: { venueId?: string; meetingId?: string; ext?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  if (!body.venueId || !body.meetingId) {
    return NextResponse.json({ ok: false, error: "missing_fields" }, { status: 400 });
  }
  try {
    const path = audioPathFor(body.venueId, body.meetingId, body.ext ?? "webm");
    const { url, token } = await createUploadUrl(path);
    return NextResponse.json({ ok: true, path, url, token, maxBytes: MAX_AUDIO_BYTES });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
