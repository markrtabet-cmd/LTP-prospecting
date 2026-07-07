"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// What the login screen knows about the visitor, from /api/login/context:
// behind Cloudflare Access the email OTP has already identified them, so we
// greet by name and ask only for the password. Otherwise: name + password.
type LoginContext =
  | { mode: "loading" }
  | { mode: "password" }
  | { mode: "cf"; email: string; name: string; firstName: string; hasPersonalPassword: boolean };

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const from = params.get("from") || "/dashboard";

  const [ctx, setCtx] = useState<LoginContext>({ mode: "loading" });
  const [name, setName] = useState(() => {
    if (typeof window === "undefined") return "";
    try { return localStorage.getItem("ltp_rep_name") ?? ""; } catch { return ""; }
  });
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/login/context")
      .then((r) => (r.ok ? r.json() : { mode: "password" }))
      .then((d: { mode?: string; email?: string; name?: string; firstName?: string; hasPersonalPassword?: boolean }) => {
        if (cancelled) return;
        if (d?.mode === "cf" && d.email && d.name) {
          setCtx({
            mode: "cf",
            email: d.email,
            name: d.name,
            firstName: d.firstName || d.name,
            hasPersonalPassword: Boolean(d.hasPersonalPassword),
          });
        } else {
          setCtx({ mode: "password" });
        }
      })
      .catch(() => {
        if (!cancelled) setCtx({ mode: "password" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const cfMode = ctx.mode === "cf";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!cfMode && !name.trim()) {
      setError("Enter your name.");
      return;
    }
    if (!password) {
      setError("Enter your password.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      // In Cloudflare mode the server derives the identity from the Access
      // token on the request — the body only needs the password.
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cfMode ? { password } : { name: name.trim(), password }),
      });
      if (!res.ok) {
        setError(cfMode ? "Wrong password." : "Wrong name or password.");
        return;
      }
      if (!cfMode) {
        try { localStorage.setItem("ltp_rep_name", name.trim()); } catch { /* ignore */ }
      }
      router.replace(from);
      router.refresh();
    } catch {
      setError("Something went wrong — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-50 to-slate-100 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-xl ring-1 ring-slate-200">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-500 text-xl font-bold text-white">
            LTP
          </div>
          {cfMode ? (
            <>
              <h1 className="text-lg font-semibold text-slate-900">Hello, {ctx.firstName}</h1>
              <p className="text-sm text-slate-500">{ctx.email}</p>
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold text-slate-900">La Tua Pasta</h1>
              <p className="text-sm text-slate-500">Restaurant Prospecting Tool</p>
            </>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {!cfMode && (
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Your name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Mark"
                autoFocus={!name}
                autoComplete="username"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              />
              <p className="mt-1 text-xs text-slate-400">
                Your calendar, meetings and notes are kept under this name.
              </p>
            </div>
          )}
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              {cfMode ? "Your password" : "Password"}
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoFocus={cfMode || !!name}
              autoComplete="current-password"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={busy || ctx.mode === "loading"}
            className="w-full rounded-lg bg-brand-500 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60"
          >
            {busy ? "Checking…" : cfMode ? `Sign in as ${ctx.firstName}` : "Sign in"}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-slate-400">
          {cfMode
            ? ctx.hasPersonalPassword
              ? "This account is protected by your personal password."
              : "Use the shared team password until a personal one is set for you."
            : "Use your own password if one is set for you — otherwise the shared team password."}
        </p>
      </div>
    </div>
  );
}
