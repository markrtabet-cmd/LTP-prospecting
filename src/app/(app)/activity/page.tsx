"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { useRestaurants } from "@/lib/store";
import { useRep } from "@/lib/rep";
import { ownsCustomer } from "@/lib/ownership";
import { detectChain } from "@/lib/chains";
import { useMeetings } from "@/lib/meetings-store";
import type { ContactNote, ContactOutcome, Rep, Restaurant } from "@/lib/types";
import { isAdhocMeeting } from "@/lib/types";

// "My activity" = anything on one of my accounts (a customer I own or a lead
// I've claimed), plus notes I personally logged. Drives the per-rep scoping.
function entryBelongsToRep(r: Restaurant, note: ContactNote, rep: Rep, reps: Rep[]): boolean {
  if (ownsCustomer(r, rep, reps) || r.claimedByRepId === rep.id) return true;
  const first = rep.name.split(" ")[0]?.toLowerCase();
  return Boolean(first && note.author?.toLowerCase().includes(first));
}

const OUTCOME_LABELS: Record<ContactOutcome, string> = {
  called: "Called",
  emailed: "Emailed",
  visited: "Visited",
  meeting: "Meeting",
  samples_sent: "Samples sent",
  quote_sent: "Quote sent",
  interested: "Interested",
  not_interested: "Not interested",
  no_answer: "No answer",
  follow_up: "Follow-up",
  other: "Note",
};

const OUTCOME_STYLE: Record<ContactOutcome, string> = {
  called: "bg-slate-100 text-slate-700",
  emailed: "bg-slate-100 text-slate-700",
  visited: "bg-slate-100 text-slate-700",
  meeting: "bg-indigo-100 text-indigo-700",
  samples_sent: "bg-indigo-100 text-indigo-700",
  quote_sent: "bg-indigo-100 text-indigo-700",
  interested: "bg-green-100 text-green-700",
  not_interested: "bg-red-100 text-red-700",
  no_answer: "bg-amber-100 text-amber-700",
  follow_up: "bg-amber-100 text-amber-700",
  other: "bg-slate-100 text-slate-700",
};

const PERIODS = [
  { label: "All time", days: null },
  { label: "Last week", days: 7 },
  { label: "Last month", days: 30 },
  { label: "Last 3 months", days: 90 },
  { label: "Last year", days: 365 },
] as const;

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return (
    d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) +
    " · " +
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  );
}

// restaurant is null for a completed ad-hoc (off-map) meeting — its name shows
// as plain text (there's no profile to link to yet).
type Entry = { note: ContactNote; restaurant: Restaurant | null; adhocName?: string };

export default function ActivityPage() {
  // Read the FULL list (incl. excluded / non-London venues): a logged note or
  // meeting is a historical record and must stay in the log even after its
  // venue is later excluded, so activity is never silently lost.
  const { allRestaurants, updateRestaurant } = useRestaurants();
  const { meetings } = useMeetings();
  const { reps, seesEverything, subjectRep } = useRep();

  const [periodDays, setPeriodDays] = useState<number | null>(null);
  const [outcomeFilter, setOutcomeFilter] = useState<ContactOutcome | "">("");
  const [search, setSearch] = useState("");
  const [chainOnly, setChainOnly] = useState(false);
  // Whose activity we show follows the site-wide switcher (subjectRep): a rep is
  // locked to themselves; an admin sees everyone (whole company) or one rep.

  const allEntries = useMemo<Entry[]>(() => {
    const entries: Entry[] = [];
    for (const r of allRestaurants) {
      for (const note of r.contactLog ?? []) {
        entries.push({ note, restaurant: r });
      }
    }
    // Completed ad-hoc (off-map) meetings have no venue/contactLog — surface each
    // as an activity entry straight from the meeting record. Once a meeting is
    // linked to a venue its note lands in that venue's contactLog (above), so
    // skip linked ones here to avoid a duplicate.
    for (const m of meetings) {
      if (!isAdhocMeeting(m) || m.status !== "completed") continue;
      entries.push({
        note: {
          id: `mtg_${m.id}`,
          author: m.repName ?? "Sales team",
          text: m.aiSummary?.trim() || m.notes?.trim() || "Meeting recorded",
          outcome: m.type === "call" ? "called" : m.type === "visit" ? "visited" : "meeting",
          at: m.date,
          repId: m.repId,
          meetingId: m.id,
        },
        restaurant: null,
        adhocName: m.venueName,
      });
    }
    entries.sort((a, b) => new Date(b.note.at).getTime() - new Date(a.note.at).getTime());
    return entries;
  }, [allRestaurants, meetings]);

  const filtered = useMemo(() => {
    const now = Date.now();
    return allEntries.filter(({ note, restaurant: r, adhocName }) => {
      // Role scoping: a rep only sees their own activity; an admin/dev sees all
      // (or one selected rep's). Ad-hoc entries (no venue) scope purely by who
      // logged them.
      if (subjectRep) {
        if (r ? !entryBelongsToRep(r, note, subjectRep, reps) : note.repId !== subjectRep.id) return false;
      } else if (!seesEverything) {
        return false;
      }
      if (periodDays !== null) {
        const age = now - new Date(note.at).getTime();
        if (age > periodDays * 86_400_000) return false;
      }
      if (outcomeFilter && note.outcome !== outcomeFilter) return false;
      const name = r ? r.name : (adhocName ?? "");
      if (search && !name.toLowerCase().includes(search.toLowerCase())) return false;
      if (chainOnly && (!r || !detectChain(r.name))) return false;
      return true;
    });
  }, [allEntries, periodDays, outcomeFilter, search, chainOnly, subjectRep, reps, seesEverything]);

  function deleteEntry(restaurant: Restaurant, noteId: string) {
    updateRestaurant(restaurant.id, {
      contactLog: (restaurant.contactLog ?? []).filter((n) => n.id !== noteId),
    });
  }

  return (
    <div>
      <PageHeader
        title="Activity"
        subtitle={`${filtered.length} entr${filtered.length === 1 ? "y" : "ies"} across all restaurants`}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search restaurant…"
          className="min-w-[180px] flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brand-500"
        />
        <select
          value={periodDays ?? ""}
          onChange={(e) => setPeriodDays(e.target.value === "" ? null : Number(e.target.value))}
          className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
        >
          {PERIODS.map((p) => (
            <option key={p.label} value={p.days ?? ""}>{p.label}</option>
          ))}
        </select>
        <select
          value={outcomeFilter}
          onChange={(e) => setOutcomeFilter(e.target.value as ContactOutcome | "")}
          className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
        >
          <option value="">All outcomes</option>
          {(Object.keys(OUTCOME_LABELS) as ContactOutcome[]).map((o) => (
            <option key={o} value={o}>{OUTCOME_LABELS[o]}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={chainOnly}
            onChange={(e) => setChainOnly(e.target.checked)}
          />
          Chains
        </label>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl bg-white p-10 text-center text-slate-500 ring-1 ring-slate-200">
          {allEntries.length === 0
            ? "No contact activity logged yet. Go to a restaurant profile to add notes."
            : "No entries match your filters."}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs font-semibold text-slate-500">
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Restaurant</th>
                <th className="px-4 py-3">Cuisine · Borough</th>
                <th className="px-4 py-3">Outcome</th>
                <th className="px-4 py-3">Author</th>
                <th className="px-4 py-3">Note</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map(({ note, restaurant: r, adhocName }) => (
                <tr key={note.id} className="group hover:bg-slate-50">
                  <td className="whitespace-nowrap px-4 py-3 text-slate-500">{formatWhen(note.at)}</td>
                  <td className="px-4 py-3">
                    {r ? (
                      <Link href={`/restaurants/${r.id}?from=activity`} className="font-medium text-brand-600 hover:underline">
                        {r.name}
                      </Link>
                    ) : (
                      // Off-map booking — no profile to link to yet.
                      <span className="font-medium text-slate-700">{adhocName}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{r ? `${r.cuisineType} · ${r.borough}` : "Off-map booking"}</td>
                  <td className="px-4 py-3">
                    {note.outcome ? (
                      <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${OUTCOME_STYLE[note.outcome]}`}>
                        {OUTCOME_LABELS[note.outcome]}
                      </span>
                    ) : "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-700">{note.author}</td>
                  <td className="px-4 py-3 text-slate-600" title={note.text}>
                    {note.text.length > 100 ? note.text.slice(0, 100) + "…" : note.text}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {r && (
                      <button
                        onClick={() => {
                          if (confirm(`Delete this ${note.outcome ? OUTCOME_LABELS[note.outcome].toLowerCase() : "note"} for ${r.name}?`)) {
                            deleteEntry(r, note.id);
                          }
                        }}
                        className="text-slate-300 opacity-0 transition group-hover:opacity-100 hover:text-red-600"
                        title="Delete entry"
                      >
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
