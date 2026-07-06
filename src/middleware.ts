import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionValue } from "@/lib/session";
import { cfAccessConfigured, verifyAccessJwt } from "@/lib/cf-access";

// Server-side route guard. Any route that is not public requires a VALID
// signed session cookie (rep identity — see src/lib/session.ts); otherwise the
// user is redirected to /login. Legacy "1" cookies from the shared-password
// era fail verification, forcing a one-time re-login.

// manifest.webmanifest must be public: browsers fetch it to offer "install
// app", including from the login screen (icons are already exempt via the
// matcher's file-extension rule).
const PUBLIC_PATHS = ["/login", "/api/login", "/manifest.webmanifest"];

// Vercel Cron endpoints have no session cookie, so they must bypass the login
// gate; each protects itself with CRON_SECRET instead. scan-openings is only
// exempt for GET (the cron verb) — its POST (in-app "Scan now") stays behind
// the session gate.
function isCronRequest(pathname: string, method: string): boolean {
  if (pathname.startsWith("/api/sync-customers")) return true;
  if (pathname.startsWith("/api/scan-openings") && method === "GET") return true;
  if (pathname.startsWith("/api/business-health/recompute")) return true;
  return false;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isCronRequest(pathname, request.method)) return NextResponse.next();

  // Cloudflare Access lock (opt-in via CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD):
  // every non-cron request must carry a valid Cloudflare-signed Access token.
  // This closes the *.vercel.app side door — traffic that didn't come through
  // the Cloudflare-protected domain is rejected before anything else runs.
  if (cfAccessConfigured()) {
    const jwt = request.headers.get("cf-access-jwt-assertion");
    const accessOk = jwt ? await verifyAccessJwt(jwt) : null;
    if (!accessOk) {
      return new NextResponse("Forbidden: use the company address for this app.", { status: 403 });
    }
  }

  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));
  const session = await verifySessionValue(request.cookies.get(SESSION_COOKIE)?.value);

  // Logged-in user visiting the login page -> send to dashboard.
  if (pathname === "/login" && session) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  // Unauthenticated user on a protected route -> send to login.
  if (!isPublic && !session) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Run on everything except static assets and Next internals.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
