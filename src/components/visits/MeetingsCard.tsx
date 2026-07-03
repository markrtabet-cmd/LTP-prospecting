"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, FileText, Play } from "lucide-react";
import { useMeetings } from "@/lib/meetings-store";
import { VISIT_LABELS } from "@/lib/visits/types";
import type { Meeting } from "@/lib/types";

// Meeting history for a venue (all reps): summaries, action points, and the
// retained audio — the proper record of every meeting, playable on demand via
// short-lived signed URLs.
export function MeetingsCard({ venueId }: { venueId: string }) {
  const { meetings } = useMeetings();
  const venueMeetings = useMemo(
    () =>
      meetings
        .filter((m) => m.venueId === venueId && m.status !== "cancelled")
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, 20),
    [meetings, venueId],
  );

  if (venueMeetings.length === 0) return null;

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Meetings</h2>
        <span className="text-xs text-slate-400">{venueMeetings.length} on record</span>
      </div>
      <ul className="space-y-2">
        {venueMeetings.map((m) => (
          <MeetingRow key={m.id} m={m} />
        ))}
      </ul>
    </div>
  );
}

const STATUS_STYLE: Record<Meeting["status"], string> = {
  completed: "bg-green-100 text-green-700",
  scheduled: "bg-blue-100 text-blue-700",
  missed: "bg-red-100 text-red-700",
  cancelled: "bg-slate-100 text-slate-500",
};

function MeetingRow({ m }: { m: Meeting }) {
  const [open, setOpen] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  async function signedUrl(path: string): Promise<string | null> {
    const res = await fetch(`/api/meetings/media?path=${encodeURIComponent(path)}`);
    const d = await res.json();
    return d.ok ? (d.url as string) : null;
  }

  async function playAudio() {
    if (!m.audioPath || audioUrl) return;
    setLoading("audio");
    const url = await signedUrl(m.audioPath);
    setAudioUrl(url);
    setLoading(null);
  }

  async function loadTranscript() {
    if (!m.transcriptPath || transcript) return;
    setLoading("transcript");
    const url = await signedUrl(m.transcriptPath);
    if (url) {
      try {
        const text = await (await fetch(url)).text();
        setTranscript(text);
      } catch {
        setTranscript("Couldn't load the transcript.");
      }
    }
    setLoading(null);
  }

  const hasDetail = Boolean(m.aiSummary || m.notes || m.actionItems?.length || m.audioPath || m.transcriptPath);

  return (
    <li className="rounded-lg bg-slate-50 px-3 py-2.5">
      <button
        onClick={() => hasDetail && setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <div className="flex min-w-0 items-center gap-2 text-xs text-slate-500">
          <span className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${STATUS_STYLE[m.status]}`}>
            {VISIT_LABELS.meetingStatus[m.status]}
          </span>
          <span className="font-medium text-slate-700">
            {new Date(m.date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
          </span>
          <span className="truncate">· {VISIT_LABELS.meetingType[m.type]}{m.repName ? ` · ${m.repName}` : ""}</span>
        </div>
        {hasDetail && (open ? <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />)}
      </button>

      {open && (
        <div className="mt-2 space-y-2 border-t border-slate-200 pt-2">
          {m.aiSummary && <p className="whitespace-pre-wrap text-sm text-slate-700">{m.aiSummary}</p>}
          {m.actionItems && m.actionItems.length > 0 && (
            <ul className="list-inside list-disc text-xs text-slate-600">
              {m.actionItems.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          )}
          {m.notes && !m.aiSummary && <p className="whitespace-pre-wrap text-xs text-slate-600">{m.notes}</p>}
          {m.reason && <p className="text-xs italic text-slate-400">{m.reason}</p>}

          <div className="flex flex-wrap gap-2">
            {m.audioPath && !audioUrl && (
              <button
                onClick={playAudio}
                className="flex items-center gap-1 rounded-lg bg-white px-2 py-1 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200"
              >
                <Play className="h-3 w-3" /> {loading === "audio" ? "Loading…" : "Play recording"}
              </button>
            )}
            {m.transcriptPath && !transcript && (
              <button
                onClick={loadTranscript}
                className="flex items-center gap-1 rounded-lg bg-white px-2 py-1 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200"
              >
                <FileText className="h-3 w-3" /> {loading === "transcript" ? "Loading…" : "Full transcript"}
              </button>
            )}
          </div>
          {audioUrl && <audio controls src={audioUrl} className="w-full" />}
          {transcript && (
            <p className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-white p-2 text-xs text-slate-600 ring-1 ring-slate-200">
              {transcript}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
