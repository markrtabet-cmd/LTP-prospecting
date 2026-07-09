"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  ExternalLink,
  Loader2,
  Mail,
  Mic,
  Repeat,
  Save,
  Sparkles,
  Square,
  Upload,
  X,
} from "lucide-react";
import { useRestaurants } from "@/lib/store";
import { useMeetings, buildScheduledMeeting } from "@/lib/meetings-store";
import { useRep } from "@/lib/rep";
import { claimPatch } from "@/lib/ownership";
import { findNameInText } from "@/lib/visits/match";
import { followUpDateKey, type FollowUpDetection } from "@/lib/visits/followup";
import { venueHasVisitSignal } from "@/lib/visits/schedule";
import { toDateKey, fmtShortDay, fromDateKey, dateKeyToLoggedIso } from "@/lib/visits/dates";
import { type MeetingType } from "@/lib/visits/types";
import type { ContactNote, Meeting, Restaurant } from "@/lib/types";

// Record-a-meeting flow, popped up from the map's activity log (outcome
// "meeting"), the calendar, or the venue profile. Records audio with a live
// transcript preview, then runs the accuracy pipeline server-side (upload →
// domain-biased transcription → glossary-aware summary + follow-up detection).
// The audio itself is ALWAYS kept in Storage as the permanent record.

// Minimal typings for the browser SpeechRecognition API (not in lib.dom).
type SpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>;
};

function pickAudioMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
  for (const c of candidates) if (MediaRecorder.isTypeSupported(c)) return c;
  return "";
}

function extFor(mime: string): string {
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  return "webm";
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, "0")}`;
}

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export function RecordMeetingSheet({
  venue: presetVenue,
  scheduledMeeting,
  initialNotes,
  onClose,
  onSaved,
}: {
  /** Preselected venue (from pin / profile / calendar). Null → the sheet will
   * work out who the meeting was with from what's said. */
  venue: Restaurant | null;
  /** When completing a specific calendar entry. */
  scheduledMeeting?: Meeting;
  initialNotes?: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { restaurants, updateRestaurant } = useRestaurants();
  const { completeVisit, addMeeting } = useMeetings();
  const { me, reps } = useRep();

  const [venue, setVenue] = useState<Restaurant | null>(presetVenue);
  const [venueQuery, setVenueQuery] = useState("");
  const [matches, setMatches] = useState<{ venue: Restaurant; score: number }[]>([]);

  const [dateKey, setDateKey] = useState(() =>
    scheduledMeeting ? toDateKey(new Date(scheduledMeeting.date)) : toDateKey(new Date()),
  );
  const [type, setType] = useState<MeetingType>(scheduledMeeting?.type ?? "in_person");
  // The record sheet logs just two kinds: a Meeting (in person) or a Call.
  const isCall = type === "phone";

  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [transcript, setTranscript] = useState(initialNotes ?? "");
  const [interim, setInterim] = useState("");
  const [summary, setSummary] = useState("");
  const [actionText, setActionText] = useState("");
  const [followUp, setFollowUp] = useState<FollowUpDetection | null>(null);
  const [followUpKey, setFollowUpKey] = useState<string | null>(null);
  const [transcriptPath, setTranscriptPath] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState<{ subject: string; body: string; to: string; reason: string | null } | null>(null);
  const [frequencyChange, setFrequencyChange] = useState<{ newIntervalDays: number; quote: string | null } | null>(null);

  const [processing, setProcessing] = useState<string | null>(null); // step label
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const blobRef = useRef<Blob | null>(null);
  const mimeRef = useRef<string>("");
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const finalRef = useRef<string>(initialNotes ? initialNotes + " " : "");
  const audioUrlRef = useRef<string | null>(null);
  const uploadedRef = useRef<{ path: string; mime: string } | null>(null);
  // One recording id per sheet: storage paths stay stable across retries.
  const recordingIdRef = useRef(`rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`);

  const [speechSupported, setSpeechSupported] = useState(false);
  const [recordSupported, setRecordSupported] = useState(false);

  useEffect(() => {
    setSpeechSupported(
      typeof window !== "undefined" &&
        ("SpeechRecognition" in window || "webkitSpeechRecognition" in window),
    );
    setRecordSupported(
      typeof navigator !== "undefined" &&
        !!navigator.mediaDevices &&
        typeof MediaRecorder !== "undefined",
    );
  }, []);

  useEffect(() => {
    audioUrlRef.current = audioUrl;
  }, [audioUrl]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      recognitionRef.current?.stop();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  // Venues a meeting is realistically with (customers + anything with visit
  // history) — keeps fuzzy matching fast on the 20k dataset.
  const meetingCandidates = useMemo(
    () => restaurants.filter((r) => r.existingCustomer || venueHasVisitSignal(r)),
    [restaurants],
  );

  const searchResults = useMemo(() => {
    const q = venueQuery.trim().toLowerCase();
    if (q.length < 2) return [];
    const hit: Restaurant[] = [];
    for (const r of restaurants) {
      if (r.name.toLowerCase().includes(q)) hit.push(r);
      if (hit.length >= 6) break;
    }
    return hit;
  }, [venueQuery, restaurants]);

  function matchFromTranscript(text: string) {
    if (!text.trim() || venue) return;
    const found = findNameInText(text, meetingCandidates, (r) => r.name, 0.55).slice(0, 3);
    setMatches(found.map((f) => ({ venue: f.candidate, score: f.score })));
    if (found.length > 0 && found[0].score >= 0.85) {
      setVenue(found[0].candidate);
      setNotice(`Matched to ${found[0].candidate.name} — change it if that's wrong.`);
    }
  }

  async function startRecording() {
    setError(null);
    setNotice(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickAudioMime();
      mimeRef.current = mime || "audio/webm";
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeRef.current });
        blobRef.current = blob;
        uploadedRef.current = null; // new take → new upload
        if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
        setAudioUrl(URL.createObjectURL(blob));
      };
      mr.start();
      mediaRecorderRef.current = mr;

      if (speechSupported) {
        const Ctor =
          (window as unknown as { SpeechRecognition?: new () => SpeechRecognition }).SpeechRecognition ||
          (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognition }).webkitSpeechRecognition;
        if (Ctor) {
          const rec = new Ctor();
          rec.lang = "en-GB";
          rec.continuous = true;
          rec.interimResults = true;
          finalRef.current = transcript ? transcript + " " : "";
          rec.onresult = (e) => {
            let interimText = "";
            for (let i = e.resultIndex; i < e.results.length; i++) {
              const r = e.results[i];
              if (r.isFinal) finalRef.current += r[0].transcript + " ";
              else interimText += r[0].transcript;
            }
            setTranscript(finalRef.current.trim());
            setInterim(interimText);
          };
          rec.onerror = () => {};
          rec.onend = () => setInterim("");
          rec.start();
          recognitionRef.current = rec;
        }
      }

      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
      setRecording(true);
    } catch {
      setError("Couldn't access the microphone. Check permissions, or upload a file / type notes instead.");
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    recognitionRef.current?.stop();
    if (timerRef.current) clearInterval(timerRef.current);
    setInterim("");
    setRecording(false);
    // Give the recorder a beat to flush, then run the accuracy pipeline.
    setTimeout(() => {
      if (!venue) matchFromTranscript(finalRef.current);
      void processAudio();
    }, 600);
  }

  function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_AUDIO_BYTES) {
      setError("That file is over 25 MB — trim it or record in-app instead.");
      return;
    }
    blobRef.current = file;
    mimeRef.current = file.type || "audio/mpeg";
    uploadedRef.current = null;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(URL.createObjectURL(file));
    void processAudio();
  }

  /** Upload the audio (always kept), then server-transcribe (more accurate than
   * the live preview) and summarise. Each step degrades gracefully. */
  async function processAudio() {
    const blob = blobRef.current;
    if (!blob) return;
    setError(null);
    try {
      const path = await ensureUploaded();
      let text = finalRef.current.trim();

      if (path) {
        setProcessing("Transcribing…");
        const res = await fetch("/api/meetings/transcribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            path,
            venueId: venue?.id ?? "unmatched",
            meetingId: recordingIdRef.current,
            venueName: venue?.name,
            contactName: venue?.customerContactName,
          }),
        });
        const d = await res.json();
        if (d.ok && d.transcript) {
          text = d.transcript;
          setTranscript(d.transcript);
          finalRef.current = d.transcript + " ";
          setTranscriptPath(d.transcriptPath ?? null);
          if (!venue) matchFromTranscript(d.transcript);
        } else if (!text && d.error) {
          setNotice(d.error);
        }
      }

      if (text.trim()) await summarise(text);
    } catch {
      setError("Processing failed — your recording is safe; you can retry or just type notes.");
    } finally {
      setProcessing(null);
    }
  }

  async function ensureUploaded(): Promise<string | null> {
    const blob = blobRef.current;
    if (!blob) return null;
    if (uploadedRef.current) return uploadedRef.current.path;
    setProcessing("Saving audio…");
    try {
      const res = await fetch("/api/meetings/upload-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          venueId: venue?.id ?? "unmatched",
          meetingId: recordingIdRef.current,
          ext: extFor(mimeRef.current),
        }),
      });
      const d = await res.json();
      if (!d.ok || !d.url) {
        if (d.configured === false) setNotice("Shared storage isn't set up — saving notes without the audio file.");
        return null;
      }
      const put = await fetch(d.url, {
        method: "PUT",
        headers: { "content-type": mimeRef.current || "application/octet-stream" },
        body: blob,
      });
      if (!put.ok) return null;
      uploadedRef.current = { path: d.path, mime: mimeRef.current };
      return d.path;
    } catch {
      return null;
    }
  }

  async function summarise(textOverride?: string) {
    const text = (textOverride ?? [transcript, summary].filter(Boolean).join("\n")).trim();
    if (!text) {
      setNotice("Record or type some notes first.");
      return;
    }
    setProcessing("Summarising…");
    setError(null);
    try {
      const res = await fetch("/api/meetings/summarize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          venueName: venue?.name,
          contactName: venue?.customerContactName,
          meetingDate: dateKey,
        }),
      });
      const d = await res.json();
      if (d.ok) {
        if (d.summary) setSummary(d.summary);
        if (Array.isArray(d.actionItems)) setActionText(d.actionItems.join("\n"));
        if (d.followUp) {
          setFollowUp(d.followUp);
          setFollowUpKey(followUpDateKey(d.followUp, fromDateKey(dateKey)));
        } else {
          setFollowUp(null);
          setFollowUpKey(null);
        }
        if (d.emailNeeded) {
          const need = `${d.emailNeeded.reason ?? ""} ${d.emailNeeded.subject ?? ""} ${d.emailNeeded.body ?? ""}`;
          if (/sample/i.test(need)) {
            // Samples → the customer-service samples request (addressed to CS),
            // with a recap of the meeting — NOT a warm email back to the venue.
            const to = process.env.NEXT_PUBLIC_CUSTOMER_SERVICE_EMAIL || "info@latuapasta.com";
            const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
            const body = [
              `Please arrange product samples for ${venue?.name} (${venue?.postcode}), agreed in a meeting:`,
              "",
              "Samples requested:",
              (d.emailNeeded.reason || d.emailNeeded.body || "").trim(),
              "",
              `Account code: ${venue?.customerAccountCode || "—"}`,
              `Account manager: ${venue?.customerAccountManager || "—"}`,
              `Deliver to: ${[venue?.address, venue?.postcode].filter(Boolean).join(", ")}`,
              "",
              "Meeting recap:",
              (d.summary || summary || "").trim() || "(see meeting notes)",
              "",
              `Requested by: ${me?.name || "Sales"} on ${today}`,
            ].join("\n");
            setEmailDraft({ subject: `Sample request: ${venue?.name} (${venue?.postcode})`, body, to, reason: d.emailNeeded.reason ?? null });
          } else {
            setEmailDraft({
              subject: d.emailNeeded.subject,
              body: d.emailNeeded.body,
              to: venue?.customerContactEmail ?? "",
              reason: d.emailNeeded.reason ?? null,
            });
          }
        } else {
          setEmailDraft(null);
        }
        if (d.frequencyChange?.newIntervalDays) {
          setFrequencyChange({ newIntervalDays: d.frequencyChange.newIntervalDays, quote: d.frequencyChange.quote ?? null });
        } else {
          setFrequencyChange(null);
        }
        if (!d.aiGenerated) setNotice("Drafted without AI (no key set) — edit as needed.");
      } else {
        setError(d.error || "Couldn't generate a summary.");
      }
    } catch {
      setError("Couldn't generate a summary.");
    } finally {
      setProcessing(null);
    }
  }

  async function save() {
    if (!me) return;
    if (!venue) {
      setError("Pick which venue this meeting was with.");
      return;
    }
    if (!transcript.trim() && !summary.trim() && !blobRef.current) {
      setError("Nothing to save yet — record or type what happened.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Audio is the permanent record — make sure it's up before anything else.
      const audioPath = await ensureUploaded();

      const actionItems = actionText.split("\n").map((s) => s.trim()).filter(Boolean);

      // 1. The meeting itself (reconciles with the scheduled calendar entry).
      const meetingId = completeVisit({
        repId: me.id,
        repName: me.name,
        venue,
        dateKey,
        type,
        notes: transcript.trim() ? transcript.trim().slice(0, 2000) : undefined,
        aiSummary: summary.trim() || undefined,
        actionItems: actionItems.length ? actionItems : undefined,
        followUpRequired: Boolean(followUpKey) || actionItems.length > 0,
        audioPath: audioPath ?? undefined,
        audioMimeType: audioPath ? mimeRef.current : undefined,
        transcriptPath: transcriptPath ?? undefined,
      });

      // 2. Mirror into the venue's contact log so the Activity feed, profile
      //    and rhythm engine all see it with zero changes. Meeting a PROSPECT
      //    auto-claims it for this rep ("takes charge"), so it drops off the
      //    other reps' leads — unless someone already owns it.
      const note: ContactNote = {
        id: `note_${Date.now()}`,
        author: me.name,
        text: summary.trim() || transcript.trim().slice(0, 500) || `${isCall ? "Call" : "Meeting"} recorded`,
        outcome: isCall ? "called" : "meeting",
        at: dateKeyToLoggedIso(dateKey),
        repId: me.id,
        meetingId,
      };
      const autoClaim = !venue.existingCustomer && !venue.claimedByRepId;
      updateRestaurant(venue.id, {
        contactLog: [...(venue.contactLog ?? []), note],
        ...(autoClaim ? claimPatch({ id: me.id, name: me.name }) : {}),
      });

      // 3. Chain the detected follow-up commitment into the calendar as a
      //    confirmed, locked entry.
      if (followUpKey) {
        addMeeting(
          buildScheduledMeeting({
            repId: me.id,
            repName: me.name,
            venue,
            dateKey: followUpKey,
            type: "in_person",
            source: "followup",
            reason: followUp?.quote ? `“${followUp.quote}”` : "Follow-up from meeting",
          }),
        );
      }

      // 4. Detected "needs samples/info" → save the draft on the venue (not
      //    the prospecting outreach pipeline — this is an existing customer).
      //    The rep sends it themselves via the mailto link above; this just
      //    keeps it from being lost if they don't click it in the moment.
      if (emailDraft) {
        updateRestaurant(venue.id, {
          emailSubject: emailDraft.subject,
          emailBody: emailDraft.body,
          emailTo: emailDraft.to || undefined,
        });
      }

      // 5. Detected an explicit ongoing-cadence change → update the venue's
      //    visit rhythm (manual interval, same field the rep edits by hand).
      if (frequencyChange) {
        updateRestaurant(venue.id, {
          visitSettings: {
            ...venue.visitSettings,
            intervalMode: "manual",
            manualIntervalDays: frequencyChange.newIntervalDays,
            setupCompleted: true,
          },
        });
      }

      onSaved?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const repNames = useMemo(() => reps.map((r) => r.name).join(", "), [reps]);

  return (
    <div className="fixed inset-0 z-[1300] flex flex-col bg-white">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-bold text-slate-900">
            {venue ? venue.name : "Record meeting"}
          </h2>
          <p className="text-xs text-slate-500">
            {scheduledMeeting ? "Completing the planned visit" : `${isCall ? "Call" : "Meeting"} record`}
            {me ? ` · ${me.name}` : ""}
          </p>
        </div>
        <button onClick={onClose} className="p-2 text-slate-400 active:text-slate-700" aria-label="Close">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {/* Consent */}
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Make sure everyone is happy to be recorded. Audio is kept as the meeting record. Recording stops if the phone locks.</span>
        </div>

        {/* Venue matching (only when opened without a venue) */}
        {!venue && (
          <div className="rounded-xl bg-slate-50 p-3">
            <p className="mb-2 text-xs font-semibold text-slate-600">
              Who was the meeting with? Record first and I&apos;ll work it out from what you say — or search:
            </p>
            <input
              value={venueQuery}
              onChange={(e) => setVenueQuery(e.target.value)}
              placeholder="Search venues…"
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-400"
            />
            {searchResults.map((r) => (
              <button
                key={r.id}
                onClick={() => { setVenue(r); setVenueQuery(""); setMatches([]); }}
                className="mt-1 block w-full truncate rounded-lg bg-white px-3 py-2 text-left text-sm ring-1 ring-slate-200 active:bg-slate-100"
              >
                {r.name}
              </button>
            ))}
            {matches.length > 0 && (
              <div className="mt-2">
                <p className="mb-1 text-xs text-slate-500">Did you mean:</p>
                <div className="flex flex-wrap gap-1.5">
                  {matches.map((m) => (
                    <button
                      key={m.venue.id}
                      onClick={() => { setVenue(m.venue); setMatches([]); }}
                      className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 ring-1 ring-brand-200 active:bg-brand-100"
                    >
                      {m.venue.name} ({Math.round(m.score * 100)}%)
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Date + type — equal-width columns, matched field heights */}
        <div className="grid grid-cols-2 gap-3">
          <div className="min-w-0">
            <label className="mb-1 block text-xs text-slate-500">Date</label>
            <input
              type="date"
              value={dateKey}
              onChange={(e) => setDateKey(e.target.value)}
              className="block h-11 w-full min-w-0 appearance-none rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-brand-400 [-webkit-appearance:none]"
            />
          </div>
          <div className="min-w-0">
            <label className="mb-1 block text-xs text-slate-500">Type</label>
            <select
              value={isCall ? "call" : "meeting"}
              onChange={(e) => setType(e.target.value === "call" ? "phone" : "in_person")}
              className="block h-11 w-full min-w-0 appearance-none rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:border-brand-400 [-webkit-appearance:none]"
            >
              <option value="meeting">Meeting</option>
              <option value="call">Call</option>
            </select>
          </div>
        </div>

        {/* Record */}
        <div className="flex flex-col items-center gap-2 rounded-xl bg-slate-50 py-4">
          {!recording ? (
            <button
              onClick={startRecording}
              disabled={!recordSupported || !!processing}
              className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-500 text-white shadow-lg transition-transform active:scale-95 disabled:opacity-50"
              aria-label="Start recording"
            >
              <Mic className="h-7 w-7" />
            </button>
          ) : (
            <button
              onClick={stopRecording}
              className="flex h-16 w-16 animate-pulse items-center justify-center rounded-full bg-red-600 text-white shadow-lg"
              aria-label="Stop recording"
            >
              <Square className="h-6 w-6" fill="currentColor" />
            </button>
          )}
          <div className="text-xs text-slate-500">
            {recording ? (
              <span className="font-medium text-red-600">● Recording {fmtTime(elapsed)}</span>
            ) : audioUrl ? (
              "Recorded — audio will be kept with the meeting"
            ) : recordSupported ? (
              speechSupported ? "Tap to record — live transcript appears below" : "Tap to record — transcript is generated after you stop"
            ) : (
              "Recording not supported here — upload a file or type notes"
            )}
          </div>
          <label className="flex cursor-pointer items-center gap-1 text-xs font-medium text-slate-500 underline-offset-2 active:underline">
            <Upload className="h-3.5 w-3.5" /> Upload audio instead
            <input type="file" accept="audio/*" className="hidden" onChange={onUpload} />
          </label>
          {audioUrl && <audio controls src={audioUrl} className="mt-1 w-full px-3" />}
        </div>

        {/* Transcript / notes */}
        <div>
          <label className="mb-1 block text-xs text-slate-500">Notes & transcript</label>
          <textarea
            value={transcript}
            onChange={(e) => {
              setTranscript(e.target.value);
              finalRef.current = e.target.value + " ";
            }}
            placeholder="Live transcription lands here while you record — or just type what happened."
            rows={5}
            className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-brand-400"
          />
          {interim && <p className="mt-1 text-xs italic text-slate-400">…{interim}</p>}
          <button
            onClick={() => summarise()}
            disabled={!!processing || (!transcript.trim() && !summary.trim())}
            className="mt-2 flex items-center gap-1.5 rounded-xl bg-slate-900 px-3 py-2 text-xs font-semibold text-white active:scale-95 disabled:opacity-40"
          >
            {processing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {processing ?? "Summarise & find follow-ups"}
          </button>
        </div>

        {/* Summary + actions */}
        <div>
          <label className="mb-1 block text-xs text-slate-500">Summary</label>
          <textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="A short summary of the meeting."
            rows={3}
            className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-brand-400"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-500">Action points (one per line)</label>
          <textarea
            value={actionText}
            onChange={(e) => setActionText(e.target.value)}
            placeholder={"Send seasonal samples\nUpdated price list"}
            rows={2}
            className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-brand-400"
          />
        </div>

        {/* Detected follow-up commitment → locked calendar entry */}
        {followUpKey && (
          <div className="rounded-xl bg-indigo-50 p-3 ring-1 ring-indigo-100">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-2">
                <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
                <div className="text-xs text-indigo-900">
                  <p className="font-semibold">
                    Follow-up visit will be booked for {fmtShortDay(fromDateKey(followUpKey))}
                  </p>
                  {followUp?.quote && <p className="mt-0.5 italic">“{followUp.quote}”</p>}
                  <p className="mt-0.5 text-indigo-700">Locked in — the planner arranges other visits around it.</p>
                </div>
              </div>
              <button
                onClick={() => { setFollowUp(null); setFollowUpKey(null); }}
                className="shrink-0 p-1 text-indigo-400 active:text-indigo-700"
                aria-label="Remove follow-up"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <input
              type="date"
              value={followUpKey}
              onChange={(e) => e.target.value && setFollowUpKey(e.target.value)}
              className="mt-2 rounded-lg border border-indigo-200 bg-white px-2 py-1.5 text-xs outline-none"
            />
          </div>
        )}

        {/* Detected "needs samples / info" → editable email draft */}
        {emailDraft && (
          <div className="rounded-xl bg-blue-50 p-3 ring-1 ring-blue-100">
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="flex items-start gap-2 text-xs text-blue-900">
                <Mail className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
                <div>
                  <p className="font-semibold">Email draft ready to send</p>
                  {emailDraft.reason && <p className="mt-0.5 text-blue-700">{emailDraft.reason}</p>}
                </div>
              </div>
              <button
                onClick={() => setEmailDraft(null)}
                className="shrink-0 p-1 text-blue-400 active:text-blue-700"
                aria-label="Remove email draft"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <input
              value={emailDraft.to}
              onChange={(e) => setEmailDraft({ ...emailDraft, to: e.target.value })}
              placeholder="Contact email"
              className="mb-1.5 w-full rounded-lg border border-blue-200 bg-white px-2 py-1.5 text-xs outline-none"
            />
            <input
              value={emailDraft.subject}
              onChange={(e) => setEmailDraft({ ...emailDraft, subject: e.target.value })}
              className="mb-1.5 w-full rounded-lg border border-blue-200 bg-white px-2 py-1.5 text-xs font-medium outline-none"
            />
            <textarea
              value={emailDraft.body}
              onChange={(e) => setEmailDraft({ ...emailDraft, body: e.target.value })}
              rows={4}
              className="w-full resize-none rounded-lg border border-blue-200 bg-white px-2 py-1.5 text-xs outline-none"
            />
            <a
              href={`mailto:${encodeURIComponent(emailDraft.to)}?subject=${encodeURIComponent(emailDraft.subject)}&body=${encodeURIComponent(emailDraft.body)}`}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white active:scale-95"
            >
              <ExternalLink className="h-3.5 w-3.5" /> Open in email app
            </a>
            <p className="mt-1.5 text-[11px] text-blue-600">Opens in your own email app — nothing is sent from here.</p>
          </div>
        )}

        {/* Detected explicit cadence change → editable visit-frequency update */}
        {frequencyChange && (
          <div className="rounded-xl bg-purple-50 p-3 ring-1 ring-purple-100">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-2 text-xs text-purple-900">
                <Repeat className="mt-0.5 h-4 w-4 shrink-0 text-purple-600" />
                <div>
                  <p className="font-semibold">Visit frequency will change</p>
                  {frequencyChange.quote && <p className="mt-0.5 italic">“{frequencyChange.quote}”</p>}
                  <p className="mt-0.5 text-purple-700">Updates their rhythm — the next suggestion uses the new interval.</p>
                </div>
              </div>
              <button
                onClick={() => setFrequencyChange(null)}
                className="shrink-0 p-1 text-purple-400 active:text-purple-700"
                aria-label="Remove frequency change"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="number"
                min={1}
                value={frequencyChange.newIntervalDays}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  if (Number.isFinite(n) && n > 0) setFrequencyChange({ ...frequencyChange, newIntervalDays: n });
                }}
                className="w-20 rounded-lg border border-purple-200 bg-white px-2 py-1.5 text-xs outline-none"
              />
              <span className="text-xs text-purple-700">days between visits</span>
            </div>
          </div>
        )}

        {error && <div className="rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-700">{error}</div>}
        {notice && <div className="rounded-xl bg-blue-50 px-3 py-2.5 text-sm text-blue-700">{notice}</div>}
        {repNames && <p className="text-[10px] text-slate-300">Name detection tuned for: {repNames}</p>}
      </div>

      {/* Save bar */}
      <div className="shrink-0 border-t border-slate-100 px-4 py-3">
        <button
          onClick={save}
          disabled={saving || !!processing}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-500 py-3.5 text-sm font-semibold text-white transition active:scale-95 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? "Saving…" : `Save ${isCall ? "call" : "meeting"}`}
        </button>
      </div>
    </div>
  );
}
