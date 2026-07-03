import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/supabase";
import { hashPassword, repSlug } from "@/lib/session";
import { getRep, listReps, removeRep, toPublicRep, upsertRep } from "@/lib/users";
import type { Rep } from "@/lib/types";

export const runtime = "nodejs";

// Sales-team roster. Session-gated by middleware like everything else — any
// signed-in rep can manage the team (small trusted team; tighten later if an
// admin role ever exists). Password hashes never leave the server.

export async function GET() {
  const reps = await listReps();
  return NextResponse.json({
    configured: isSupabaseConfigured(),
    users: reps.map(toPublicRep),
  });
}

export async function POST(req: Request) {
  let body: {
    op?: string;
    id?: string;
    name?: string;
    aliases?: string[];
    password?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  if (body.op === "upsert" && body.name?.trim()) {
    const name = body.name.trim();
    const id = body.id?.trim() || repSlug(name);
    if (!id) return NextResponse.json({ ok: false, error: "bad_name" }, { status: 400 });
    const existing = await getRep(id);
    const rep: Rep = {
      id,
      name,
      aliases: (body.aliases ?? existing?.aliases ?? []).map((a) => a.trim()).filter(Boolean),
      passwordHash: existing?.passwordHash,
      passwordSalt: existing?.passwordSalt,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    if (body.password?.trim()) {
      const { hash, salt } = await hashPassword(body.password.trim());
      rep.passwordHash = hash;
      rep.passwordSalt = salt;
    }
    const result = await upsertRep(rep);
    if (!result.ok) return NextResponse.json(result, { status: 500 });
    return NextResponse.json({ ok: true, user: toPublicRep(rep) });
  }

  if (body.op === "remove" && body.id) {
    const result = await removeRep(body.id);
    if (!result.ok) return NextResponse.json(result, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: false, error: "unknown_op" }, { status: 400 });
}
