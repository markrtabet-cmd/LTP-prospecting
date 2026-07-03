// Server-only helpers for the private "meeting-media" Storage bucket: meeting
// audio (kept permanently — the authoritative record of what was said, in case
// a transcript is bad) and full transcripts (too big for the meetings table).
// The bucket is created on first use so no manual dashboard step is needed.

import { supabaseAdmin } from "./supabase";

export const MEDIA_BUCKET = "meeting-media";

/** 25 MB — matches the transcription API's file limit. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

let bucketReady = false;

export async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const sb = supabaseAdmin();
  const { data } = await sb.storage.getBucket(MEDIA_BUCKET);
  if (!data) {
    // Race-safe: a concurrent create just errors with "already exists".
    await sb.storage
      .createBucket(MEDIA_BUCKET, { public: false, fileSizeLimit: MAX_AUDIO_BYTES })
      .catch(() => {});
  }
  bucketReady = true;
}

export function audioPathFor(venueId: string, meetingId: string, ext: string): string {
  const safeExt = ext.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "webm";
  return `audio/${sanitize(venueId)}/${sanitize(meetingId)}.${safeExt}`;
}

export function transcriptPathFor(venueId: string, meetingId: string): string {
  return `transcripts/${sanitize(venueId)}/${sanitize(meetingId)}.txt`;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

/** Reject anything that isn't a path we issued (no traversal, right prefix). */
export function isValidMediaPath(path: string): boolean {
  return /^(audio|transcripts)\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(path) && !path.includes("..");
}

export async function createUploadUrl(path: string): Promise<{ url: string; token: string }> {
  await ensureBucket();
  const { data, error } = await supabaseAdmin()
    .storage.from(MEDIA_BUCKET)
    .createSignedUploadUrl(path, { upsert: true });
  if (error || !data) throw new Error(error?.message ?? "could not create upload URL");
  return { url: data.signedUrl, token: data.token };
}

export async function createReadUrl(path: string, expiresInS = 300): Promise<string> {
  await ensureBucket();
  const { data, error } = await supabaseAdmin()
    .storage.from(MEDIA_BUCKET)
    .createSignedUrl(path, expiresInS);
  if (error || !data) throw new Error(error?.message ?? "could not sign URL");
  return data.signedUrl;
}

export async function downloadMedia(path: string): Promise<Blob> {
  await ensureBucket();
  const { data, error } = await supabaseAdmin().storage.from(MEDIA_BUCKET).download(path);
  if (error || !data) throw new Error(error?.message ?? "download failed");
  return data;
}

export async function uploadText(path: string, text: string): Promise<void> {
  await ensureBucket();
  const { error } = await supabaseAdmin()
    .storage.from(MEDIA_BUCKET)
    .upload(path, new Blob([text], { type: "text/plain; charset=utf-8" }), {
      upsert: true,
      contentType: "text/plain; charset=utf-8",
    });
  if (error) throw new Error(error.message);
}
