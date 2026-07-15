import type { ContactNote, Restaurant } from "@/lib/types";

// Fire-and-forget after every contactLog write on a PROSPECT: ask the summarize
// AI how the pursuit is going ("good" / "not_good") from the last few notes and
// stash the verdict on the venue as `noteSentiment` (colours the Lead badge on
// the leads page). NOTE the /api/data merge is a whole-row read-modify-write,
// not per-field — the store serialises its POSTs (FIFO) so this delayed write
// can't land on a stale read of a note written meanwhile; the patch itself
// still must never include contactLog. A failed/unclear call just leaves no
// fresh verdict, and the leads page falls back to purple whenever
// noteSentiment.noteId isn't the newest note.
export async function assessProspectNote(
  venue: Restaurant,
  log: ContactNote[],
  update: (id: string, patch: Partial<Restaurant>) => void,
) {
  if (venue.existingCustomer) return;
  // Emptied log: the CALLER bundles `noteSentiment: null` into its own
  // contactLog write — a separate clear here would race that write.
  if (!log.length) return;
  const latest = log.reduce((a, b) => (a.at > b.at ? a : b), log[0]);
  // Last ~5 notes, oldest first, with the outcome tag as a cheap extra signal.
  const text = [...log]
    .sort((a, b) => (a.at < b.at ? -1 : 1))
    .slice(-5)
    .map((n) => `[${n.at.slice(0, 10)}${n.outcome ? ` ${n.outcome}` : ""}] ${n.text}`)
    .join("\n");
  const d = await fetch("/api/meetings/summarize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, venueName: venue.name, mode: "note" }),
  })
    .then((r) => r.json())
    .catch(() => null);
  if (d?.sentiment === "good" || d?.sentiment === "not_good") {
    update(venue.id, {
      noteSentiment: {
        verdict: d.sentiment,
        noteId: latest.id,
        ...(typeof d.sentimentReason === "string" && d.sentimentReason ? { reason: d.sentimentReason } : {}),
        at: new Date().toISOString(),
      },
    });
  }
}
