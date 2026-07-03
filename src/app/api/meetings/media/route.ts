import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase";
import { createReadUrl, isValidMediaPath } from "@/lib/meeting-media";

export const runtime = "nodejs";

// Short-lived signed URL for playing meeting audio / fetching a transcript.
// Supabase serves range requests, so <audio> scrubbing works directly.
export async function GET(req: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: false, configured: false }, { status: 200 });
  }
  const { searchParams } = new URL(req.url);
  const path = searchParams.get("path") ?? "";
  if (!isValidMediaPath(path)) {
    return NextResponse.json({ ok: false, error: "bad_path" }, { status: 400 });
  }
  try {
    const url = await createReadUrl(path, 300);
    return NextResponse.json({ ok: true, url });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
