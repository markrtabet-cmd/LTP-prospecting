import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionValue } from "@/lib/session";
import { isSupabaseConfigured, supabaseAdmin } from "@/lib/supabase";
import {
  EMAIL_TEMPLATE_TYPES,
  type EmailTemplateMap,
  type EmailTemplateRecord,
  type EmailTemplateType,
} from "@/lib/email-templates";

// Per-rep saved outreach templates (one per audience: prospect / new_opening),
// one row per template in ltp_email_templates (id "<repId>:<emailType>", data
// jsonb). The repId is ALWAYS the session's — never a client-sent value — so a
// rep can only ever read/write their own templates. Falls back to
// {configured:false} so the client keeps templates in localStorage when
// Supabase (or the table) isn't set up yet — same pattern as /api/meetings.

export const runtime = "nodejs";
// Prevents this GET from being eligible for Next.js's automatic static
// caching, which would otherwise let one cached templates snapshot keep being
// served after a save (same bug pattern found on /api/data and /api/meetings).
export const dynamic = "force-dynamic";

const TABLE = "ltp_email_templates";

// PostgREST errors are plain objects, not Error instances.
function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return "unknown error";
}

function needsTable(message: string): boolean {
  return /relation .* does not exist|could not find the table|schema cache/i.test(message);
}

async function sessionRep() {
  const value = cookies().get(SESSION_COOKIE)?.value;
  return verifySessionValue(value);
}

export async function GET() {
  const session = await sessionRep();
  if (!session) return NextResponse.json({ ok: false }, { status: 401 });
  // Sandbox developer account: writes must stay in the browser, so reads do
  // too — report unconfigured and the client runs on localStorage.
  if (session.sandbox || !isSupabaseConfigured()) return NextResponse.json({ configured: false });
  try {
    const ids = EMAIL_TEMPLATE_TYPES.map((t) => `${session.id}:${t}`);
    const { data, error } = await supabaseAdmin().from(TABLE).select("id,data").in("id", ids);
    if (error) throw error;
    const templates: EmailTemplateMap = {};
    for (const row of data ?? []) {
      const rec = row.data as EmailTemplateRecord;
      if (rec?.emailType && EMAIL_TEMPLATE_TYPES.includes(rec.emailType)) {
        templates[rec.emailType] = { subject: rec.subject ?? "", body: rec.body ?? "" };
      }
    }
    return NextResponse.json({ configured: true, templates });
  } catch (e) {
    const message = errMessage(e);
    // Table probably not created yet — tell the client to run local-only so
    // templates still work before the SQL has been pasted in.
    if (needsTable(message)) return NextResponse.json({ configured: false, needsTable: true });
    return NextResponse.json({ configured: true, error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await sessionRep();
  if (!session) return NextResponse.json({ ok: false }, { status: 401 });
  if (session.sandbox || !isSupabaseConfigured()) {
    return NextResponse.json({ ok: false, configured: false });
  }

  let body: { emailType?: string; subject?: string; body?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const emailType = body.emailType as EmailTemplateType;
  if (!EMAIL_TEMPLATE_TYPES.includes(emailType) || typeof body.subject !== "string" || typeof body.body !== "string") {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const record: EmailTemplateRecord = {
    repId: session.id,
    emailType,
    subject: body.subject,
    body: body.body,
    updatedAt: new Date().toISOString(),
  };

  try {
    const { error } = await supabaseAdmin()
      .from(TABLE)
      .upsert({ id: `${session.id}:${emailType}`, data: record }, { onConflict: "id" });
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = errMessage(e);
    if (needsTable(message)) return NextResponse.json({ ok: false, configured: false, needsTable: true });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
