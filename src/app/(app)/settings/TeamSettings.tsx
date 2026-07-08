"use client";

import { useEffect, useState } from "react";
import type { PublicRep } from "@/lib/users";

const ROLE_STYLE: Record<string, { label: string; cls: string }> = {
  rep: { label: "Rep", cls: "bg-blue-50 text-blue-700" },
  admin: { label: "Admin", cls: "bg-purple-50 text-purple-700" },
  developer: { label: "Developer", cls: "bg-slate-200 text-slate-700" },
};

function RoleBadge({ role }: { role: PublicRep["role"] }) {
  const s = ROLE_STYLE[role ?? "rep"] ?? ROLE_STYLE.rep;
  return <span className={`ml-2 rounded px-1.5 py-0.5 text-[11px] font-semibold ${s.cls}`}>{s.label}</span>;
}

// Sales-team roster management: each rep gets their own calendar, and their
// Power BI account-manager aliases decide which customers land on it. Reps
// without a personal password sign in with the shared SITE_PASSWORD.
export function TeamSettings() {
  const [users, setUsers] = useState<PublicRep[]>([]);
  const [configured, setConfigured] = useState(true);
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const [password, setPassword] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  function load() {
    fetch("/api/users")
      .then((r) => r.json())
      .then((d: { configured?: boolean; users?: PublicRep[] }) => {
        setConfigured(d.configured !== false);
        setUsers(d.users ?? []);
      })
      .catch(() => {});
  }
  useEffect(load, []);

  function startEdit(u: PublicRep) {
    setEditingId(u.id);
    setName(u.name);
    setAliases(u.aliases.join(", "));
    setPassword("");
    setMessage("");
  }

  function reset() {
    setEditingId(null);
    setName("");
    setAliases("");
    setPassword("");
  }

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op: "upsert",
          id: editingId ?? undefined,
          name: name.trim(),
          aliases: aliases.split(",").map((s) => s.trim()).filter(Boolean),
          password: password.trim() || undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) {
        setMessage(d.error === "not_configured"
          ? "Supabase isn't configured — the roster needs the shared database."
          : "Couldn't save — has the ltp_users table been created? (see supabase-schema.sql)");
        return;
      }
      reset();
      load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Remove this rep from the roster? Their meetings stay.")) return;
    await fetch("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "remove", id }),
    });
    if (editingId === id) reset();
    load();
  }

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <h2 className="mb-1 text-sm font-semibold text-slate-900">Team accounts</h2>
      <p className="mb-3 text-xs text-slate-400">
        Everyone who can sign in — not all sales reps. <b>Reps</b> get their own calendar and see only
        their own customers; <b>admins</b> oversee the whole team; <b>developers</b> can open any account
        or an isolated sandbox. Power BI aliases (account-manager spellings) decide which customers are a
        rep&apos;s automatically.
      </p>

      {!configured && (
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Supabase isn&apos;t configured — the roster is unavailable, but anyone can still sign in
          with their name + the shared password.
        </p>
      )}

      {users.length > 0 && (
        <ul className="mb-4 space-y-2">
          {users.map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <div className="min-w-0">
                <span className="font-medium text-slate-800">{u.name}</span>
                <RoleBadge role={u.role} />
                <span className="ml-2 text-xs text-slate-400">
                  {u.hasPassword ? "own password" : "shared password"}
                  {u.aliases.length > 0 && ` · PBI: ${u.aliases.join(", ")}`}
                </span>
              </div>
              <div className="flex shrink-0 gap-2">
                <button onClick={() => startEdit(u)} className="text-xs font-medium text-brand-600 hover:underline">Edit</button>
                <button onClick={() => remove(u.id)} className="text-xs text-slate-400 hover:text-red-600">Remove</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2 rounded-lg bg-slate-50 p-3 ring-1 ring-slate-100">
        <p className="text-xs font-medium text-slate-600">{editingId ? `Editing ${name}` : "Add a rep"}</p>
        <div className="flex flex-wrap gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (used to sign in)"
            className="w-44 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand-500"
          />
          <input
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder="Power BI names, comma-separated"
            className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand-500"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={editingId ? "New password (optional)" : "Password (optional)"}
            className="w-44 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand-500"
          />
        </div>
        {message && <p className="text-xs text-amber-700">{message}</p>}
        <div className="flex justify-end gap-2">
          {editingId && (
            <button onClick={reset} className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-200">
              Cancel
            </button>
          )}
          <button
            onClick={save}
            disabled={busy || !name.trim()}
            className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-40"
          >
            {editingId ? "Save changes" : "Add rep"}
          </button>
        </div>
      </div>
    </div>
  );
}
