// Shared-password access. One password (SITE_PASSWORD) gates the whole app —
// hand it to whoever you want to have access. Verification happens server-side
// (see src/app/api/login/route.ts); the browser only holds an opaque session
// cookie. To move to individual accounts later, swap these for Supabase Auth.

export const SESSION_COOKIE = "ltp_session";

// Sign out by clearing the server cookie.
export async function signOut(): Promise<void> {
  try {
    await fetch("/api/logout", { method: "POST" });
  } catch {
    /* ignore */
  }
}
