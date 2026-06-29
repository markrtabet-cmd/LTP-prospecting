import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Server-only Supabase client (service-role key). All DB access goes through our
// own cookie-gated API routes, so the key never reaches the browser and the
// tables can stay fully locked down (RLS denies anon). When the env vars aren't
// set, the app falls back to per-browser localStorage so it still runs locally.

export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function supabaseAdmin(): SupabaseClient {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
