"use client";

import { useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { PRICE_LABELS, buildDrafts } from "@/lib/mock-data";
import { useRestaurants } from "@/lib/store";
import type { EmailDraft, Restaurant } from "@/lib/types";

const TABS = ["ready", "scheduled", "sent", "replied", "bounced"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, string> = {
  ready: "Ready for review",
  scheduled: "Scheduled",
  sent: "Sent",
  replied: "Replies",
  bounced: "Bounced",
};

export default function EmailsPage() {
  const { restaurants, updateRestaurant } = useRestaurants();
  const emailDrafts = useMemo(() => buildDrafts(restaurants), [restaurants]);

  const [tab, setTab] = useState<Tab>("ready");
  const [selected, setSelected] = useState<EmailDraft | null>(null);

  const list = emailDrafts.filter((e) => e.status === tab);
  // Tab-aware: only keep the selection if it belongs to the current tab.
  const active = (selected && list.some((e) => e.id === selected.id) ? selected : list[0]) ?? null;

  function generateTopDrafts() {
    restaurants
      .filter((r) => r.recommended && !r.existingCustomer && r.outreachStatus === "not_contacted")
      .sort((a, b) => b.leadScore - a.leadScore)
      .slice(0, 20)
      .forEach((r) => updateRestaurant(r.id, { outreachStatus: "draft_ready" }));
  }

  function setStatus(
    restaurantId: string,
    status: "sent" | "scheduled" | "not_contacted" | "replied" | "converted"
  ) {
    updateRestaurant(restaurantId, { outreachStatus: status });
    setSelected(null);
  }

  function clearDrafts() {
    restaurants
      .filter((r) => r.outreachStatus === "draft_ready")
      .forEach((r) => updateRestaurant(r.id, { outreachStatus: "not_contacted" }));
    setSelected(null);
  }

  function saveDraft(restaurantId: string, subject: string, body: string, to: string) {
    updateRestaurant(restaurantId, { emailSubject: subject, emailBody: body, emailTo: to });
  }

  const readyCount = emailDrafts.filter((e) => e.status === "ready").length;
  const activeRestaurant = active ? restaurants.find((r) => r.id === active.restaurantId) : undefined;

  return (
    <div>
      <PageHeader
        title="Email centre"
        subtitle="Review, edit and approve outreach. Nothing is sent without your approval."
        action={
          <div className="flex gap-2">
            <button onClick={generateTopDrafts} className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-600">
              Generate drafts for top fits
            </button>
            {readyCount > 0 && (
              <button onClick={clearDrafts} className="rounded-lg bg-white px-3 py-2 text-sm font-semibold text-red-600 ring-1 ring-red-200 hover:bg-red-50">
                Clear drafts ({readyCount})
              </button>
            )}
          </div>
        }
      />

      {/* How it works */}
      <div className="mb-4 flex flex-wrap gap-3 rounded-xl bg-white p-4 text-sm shadow-sm ring-1 ring-slate-200">
        <Step n={1} title="Generate" desc="Drafts are written automatically for best-fit venues using their data." />
        <Step n={2} title="Review & edit" desc="Pick a draft on the left and tweak the subject or body." />
        <Step n={3} title="Approve & send" desc="Approve to send, or schedule for later. You stay in control." />
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-1 border-b border-slate-200">
        {TABS.map((t) => {
          const count = emailDrafts.filter((e) => e.status === t).length;
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition ${
                tab === t
                  ? "border-brand-500 text-brand-600"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              {TAB_LABELS[t]} <span className="text-xs text-slate-400">({count})</span>
            </button>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        {/* List */}
        <div className="space-y-2">
          {list.map((e) => (
            <button
              key={e.id}
              onClick={() => setSelected(e)}
              className={`w-full rounded-xl bg-white p-3 text-left shadow-sm ring-1 transition ${
                active?.id === e.id ? "ring-brand-500" : "ring-slate-200 hover:ring-slate-300"
              }`}
            >
              <p className="text-sm font-semibold text-slate-900">{e.restaurantName}</p>
              <p className="truncate text-xs text-slate-500">{e.subject}</p>
              <p className="mt-1 text-xs text-slate-400">
                {e.to || "no email"} · {e.salesperson}
              </p>
            </button>
          ))}
          {list.length === 0 && (
            <div className="rounded-xl bg-white p-6 text-center text-sm text-slate-400 ring-1 ring-slate-200">
              {tab === "ready" ? (
                <>
                  <p className="mb-3">No drafts yet.</p>
                  <button onClick={generateTopDrafts} className="rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-600">
                    Generate drafts for top fits
                  </button>
                </>
              ) : (
                "No emails in this status."
              )}
            </div>
          )}
        </div>

        {/* Editor */}
        {active ? (
          <Editor
            key={active.id}
            draft={active}
            restaurant={activeRestaurant}
            onStatus={(status) => setStatus(active.restaurantId, status)}
            onSave={(subject, body, to) => saveDraft(active.restaurantId, subject, body, to)}
          />
        ) : (
          <div className="flex items-center justify-center rounded-xl bg-white p-10 text-slate-400 ring-1 ring-slate-200">
            Select an email to review.
          </div>
        )}
      </div>
    </div>
  );
}

function Editor({
  draft,
  restaurant,
  onStatus,
  onSave,
}: {
  draft: EmailDraft;
  restaurant?: Restaurant;
  onStatus: (status: "sent" | "scheduled" | "not_contacted" | "replied" | "converted") => void;
  onSave: (subject: string, body: string, to: string) => void;
}) {
  const [to, setTo] = useState(draft.to);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [aiBusy, setAiBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Persist current edits, then run a status transition — so Approve/Schedule
  // never discard unsaved subject/body/to.
  function saveThen(status: "sent" | "scheduled" | "not_contacted") {
    onSave(subject, body, to);
    onStatus(status);
  }

  async function writeWithAI() {
    if (!restaurant) return;
    setAiBusy(true);
    try {
      const res = await fetch("/api/draft-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          restaurant: {
            name: restaurant.name,
            cuisineType: restaurant.cuisineType,
            borough: restaurant.borough,
            priceLabel: PRICE_LABELS[restaurant.priceTier],
            openingStatus: restaurant.openingStatus,
            recommended: restaurant.recommended,
          },
        }),
      });
      let data: { error?: string; subject?: string; body?: string } = {};
      try {
        data = await res.json();
      } catch {
        setSavedAt("AI drafting failed.");
        return;
      }
      if (data.error || !res.ok) {
        setSavedAt(data.error === "no_api_key" ? "Add an API key to use AI drafting." : "AI drafting failed.");
        return;
      }
      const newSubject = data.subject || subject;
      const newBody = data.body || body;
      setSubject(newSubject);
      setBody(newBody);
      onSave(newSubject, newBody, to);
      setSavedAt("Written with AI ✓");
    } finally {
      setAiBusy(false);
    }
  }

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">{draft.restaurantName}</h2>
        <button
          onClick={writeWithAI}
          disabled={aiBusy || !restaurant}
          className="flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
        >
          <Sparkles size={14} />
          {aiBusy ? "Writing…" : "Write with AI"}
        </button>
      </div>

      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="text-xs font-medium text-slate-500">To</label>
          <input value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm" />
          <p className="mt-1 text-[11px] text-slate-400">Pre-filled (best-guess if no verified address) — check before sending.</p>
        </div>
        <div>
          <label className="text-xs font-medium text-slate-500">Salesperson</label>
          <input value={draft.salesperson} readOnly className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-500" />
        </div>
      </div>
      <div className="mb-3">
        <label className="text-xs font-medium text-slate-500">Subject</label>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm" />
      </div>
      <div className="mb-4">
        <label className="text-xs font-medium text-slate-500">Body</label>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={14} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {draft.status === "ready" && (
          <>
            <button onClick={() => saveThen("sent")} className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700">Approve &amp; send</button>
            <button onClick={() => saveThen("scheduled")} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600">Schedule</button>
            <button onClick={() => { onSave(subject, body, to); setSavedAt("Saved ✓"); }} className="rounded-lg bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-200">Save</button>
            <button onClick={() => onStatus("not_contacted")} className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-red-600 ring-1 ring-red-200 hover:bg-red-50">Discard</button>
          </>
        )}
        {draft.status === "scheduled" && (
          <button onClick={() => onStatus("sent")} className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700">Send now</button>
        )}
        {draft.status === "sent" && (
          <>
            <button onClick={() => onStatus("replied")} className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">Mark replied</button>
            <button onClick={() => onStatus("converted")} className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700">Mark converted</button>
          </>
        )}
        {draft.status === "replied" && (
          <button onClick={() => onStatus("converted")} className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700">Mark converted</button>
        )}
        {savedAt && <span className="text-xs text-slate-400">{savedAt}</span>}
      </div>
      <p className="mt-3 text-xs text-slate-400">Generic business email preferred · unsubscribe line included · human approval required before sending.</p>
    </div>
  );
}

function Step({ n, title, desc }: { n: number; title: string; desc: string }) {
  return (
    <div className="flex flex-1 items-start gap-3 min-w-[200px]">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-500 text-xs font-bold text-white">{n}</span>
      <div>
        <p className="font-medium text-slate-800">{title}</p>
        <p className="text-xs text-slate-500">{desc}</p>
      </div>
    </div>
  );
}
