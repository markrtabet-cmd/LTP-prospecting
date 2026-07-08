"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Check, Maximize2, Mic, Minimize2, Paperclip, Send, Sparkles, X } from "lucide-react";
import { useRestaurants } from "@/lib/store";
import { buildSamplesFollowUp, buildScheduledMeeting, useMeetings } from "@/lib/meetings-store";
import { useRep } from "@/lib/rep";
import { addDays, toDateKey } from "@/lib/visits/dates";
import type { MeetingType } from "@/lib/visits/types";
import { funnelCounts, makeRestaurant } from "@/lib/mock-data";
import { prepareOpenings, type ScannedOpening } from "@/lib/openings";
import { describeFilter, matchesFilter, resolveAreaOrBorough, resolveCuisine, type AppliedFilter } from "@/lib/filtering";
import type { ContactNote, ContactOutcome, PriceTier, Restaurant } from "@/lib/types";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import { LumenVisualization, type LumenVizBlock } from "@/components/LumenVisualization";
import { LumenMarkdown } from "@/components/LumenMarkdown";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

type Msg = {
  role: "user" | "assistant";
  content: string | Block[];
  display?: string;
  file?: string;
  blocks?: LumenVizBlock[];
  local?: boolean;
};

type ToolRun = {
  content: string;
  block?: LumenVizBlock;
  terminal?: boolean;
};

type PowerBIStoredResult = {
  result_id: string;
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated?: boolean;
};

const MAX_FILE_CHARS = 60000;
// Write actions that must be confirmed with an explicit Accept before they run,
// and that end the loop with their own message once run.
const CONFIRM_TOOL_NAMES = ["schedule_visit", "book_followup", "send_samples", "log_activity", "record_meeting"];
const CONFIRM_TOOLS = new Set(CONFIRM_TOOL_NAMES);
const TERMINAL_TOOLS = new Set([
  "navigate", "apply_filter", "clear_drafts", "generate_emails", "add_customers", "scan_openings",
  ...CONFIRM_TOOL_NAMES,
]);
const POWERBI_TOOLS = new Set(["list_datasets", "get_data_model", "run_dax_query"]);

// A human, one-line description of a pending action for the Accept card.
function describeAction(name: string, input: Record<string, unknown>): string {
  const v = String(input.venue ?? "this venue");
  const d = input.date ? ` on ${String(input.date)}` : "";
  const t = input.time ? ` at ${String(input.time)}` : "";
  switch (name) {
    case "schedule_visit": return `Book a visit to ${v}${d}${t}.`;
    case "book_followup": return `Book a follow-up at ${v}${d}${t}.`;
    case "send_samples": return `Log samples sent to ${v} and book a follow-up${d || " in a week"}.`;
    case "log_activity": return `Log a note on ${v}: “${String(input.note ?? "")}”.`;
    case "record_meeting": return `Open the meeting recorder for ${v}.`;
    default: return `Run ${name}.`;
  }
}

function fmtDateKeyShort(dateKey: string): string {
  return new Date(dateKey + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const SUGGESTIONS = [
  "Show recommended Italian leads in Hackney",
  "Draft 5 emails for best fits in Shoreditch",
  "Graph sales by product category",
  "Which customers have stopped ordering?",
];

function textOf(content: string | Block[]): string {
  if (typeof content === "string") return content;
  return content.filter((b): b is Extract<Block, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n").trim();
}

function toolUsesOf(content: string | Block[]): Extract<Block, { type: "tool_use" }>[] {
  if (typeof content === "string") return [];
  return content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
}

function isToolResultMsg(m: Msg): boolean {
  return m.role === "user" && typeof m.content !== "string" && !m.display;
}

function sanitizeForApi(msgs: Msg[]): { role: "user" | "assistant"; content: string | Block[] }[] {
  const src = msgs
    .filter((m) => !m.local)
    .map((m) => ({ role: m.role, content: m.content }))
    .filter((m) => !(typeof m.content === "string" && m.content.trim() === ""));

  const out: { role: "user" | "assistant"; content: string | Block[] }[] = [];
  for (let k = 0; k < src.length; k++) {
    const m = src[k];
    out.push(m);
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const toolIds = m.content.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use").map((b) => b.id);
      if (!toolIds.length) continue;
      const next = src[k + 1];
      const present = new Set(
        next && next.role === "user" && Array.isArray(next.content)
          ? next.content.filter((b): b is Extract<Block, { type: "tool_result" }> => b.type === "tool_result").map((b) => b.tool_use_id)
          : []
      );
      const missing = toolIds.filter((id) => !present.has(id));
      if (!missing.length) continue;
      const stubs: Block[] = missing.map((id) => ({ type: "tool_result", tool_use_id: id, content: "(no result)" }));
      if (next && next.role === "user" && Array.isArray(next.content)) src[k + 1] = { role: "user", content: [...next.content, ...stubs] };
      else out.push({ role: "user", content: stubs });
    }
  }
  return out;
}

async function readFileAsText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const XLSX = await import("xlsx");
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_csv(ws);
  }
  return file.text();
}

function validDisplayMode(value: unknown): LumenVizBlock["as"] {
  return value === "bar" || value === "line" || value === "pie" || value === "area" || value === "table" ? value : "table";
}

function columnsFor(rows: Record<string, unknown>[], fallback: string[]): string[] {
  if (fallback.length) return fallback;
  const seen = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
  return Array.from(seen);
}

function makeDisplayBlock(input: Record<string, unknown>, result: PowerBIStoredResult): LumenVizBlock {
  const as = validDisplayMode(input.as);
  const columns = columnsFor(result.rows, result.columns);
  const x = typeof input.x === "string" && columns.includes(input.x) ? input.x : columns[0] ?? null;
  const series = Array.isArray(input.series) ? input.series.filter((s): s is string => typeof s === "string" && columns.includes(s)) : null;
  return {
    kind: as === "table" ? "table" : "chart",
    as,
    title: typeof input.title === "string" ? input.title : "Power BI result",
    x,
    series,
    columns,
    rows: result.rows.slice(0, 1000),
    rowCount: result.row_count,
    truncated: result.truncated,
  };
}

function LumenMark({ className = "" }: { className?: string }) {
  return (
    <span className={`relative inline-flex items-center justify-center ${className}`} aria-hidden>
      <span className="absolute inset-0 rounded-full bg-cyan-300/35 blur-md" />
      <span className="absolute inset-0 rounded-full bg-gradient-to-br from-cyan-300 via-blue-500 to-fuchsia-500" />
      <span className="absolute inset-[4px] rounded-full bg-white/35" />
      <span className="relative h-2 w-2 rounded-full bg-white shadow" />
    </span>
  );
}

export function Assistant({ variant = "desktop" }: { variant?: "desktop" | "mobile" }) {
  const { restaurants, loading, addRestaurants, updateMany, updateRestaurant, focusIds, setFocusIds, setViewFilter } = useRestaurants();
  const { addMeeting } = useMeetings();
  const { me } = useRep();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // Desktop-only escape hatch for wide/long DAX results — mobile always uses
  // its own full-height sheet, so expanding would be meaningless there.
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [attached, setAttached] = useState<{ name: string; text: string; truncated: boolean } | null>(null);
  const [keyboard, setKeyboard] = useState({ inset: 0, top: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const powerResultsRef = useRef(new Map<string, PowerBIStoredResult>());

  // propose → Accept → run: a pending write action awaiting the rep's tap.
  const [pending, setPending] = useState<{ name: string; summary: string } | null>(null);
  const confirmResolveRef = useRef<((ok: boolean) => void) | null>(null);
  function requestConfirm(name: string, input: Record<string, unknown>): Promise<boolean> {
    return new Promise((resolve) => {
      confirmResolveRef.current = resolve;
      setPending({ name, summary: describeAction(name, input) });
    });
  }
  function resolveConfirm(ok: boolean) {
    const r = confirmResolveRef.current;
    confirmResolveRef.current = null;
    setPending(null);
    r?.(ok);
  }

  // Resolve a spoken venue name to a restaurant (exact name, else first match).
  function resolveVenue(name: string): Restaurant | undefined {
    const q = name.trim().toLowerCase();
    if (!q) return undefined;
    return (
      restaurants.find((r) => r.name.toLowerCase() === q) ??
      restaurants.find((r) => r.name.toLowerCase().includes(q))
    );
  }

  const voice = useSpeechRecognition({
    onFinal: (text) => {
      void send(text);
    },
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy, keyboard.inset]);

  // On iOS the keyboard overlays the page and Safari scrolls the whole site up
  // to reveal the focused input. Instead: pin the page and shrink the panel to
  // the visible area, so only the input bar rides up above the keyboard.
  useEffect(() => {
    if (variant !== "mobile" || !open) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const hidden = Math.round(window.innerHeight - vv.height - vv.offsetTop);
      // Small deltas are browser-chrome (URL bar) animations, not a keyboard.
      const inset = hidden > 80 ? hidden : 0;
      setKeyboard({ inset, top: inset ? Math.round(vv.offsetTop) : 0 });
      if (inset) window.scrollTo(0, 0);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      setKeyboard({ inset: 0, top: 0 });
    };
  }, [variant, open]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const raw = await readFileAsText(file);
      const truncated = raw.length > MAX_FILE_CHARS;
      setAttached({ name: file.name, text: truncated ? raw.slice(0, MAX_FILE_CHARS) : raw, truncated });
    } catch {
      setAttached({ name: file.name, text: "(could not read this file; try CSV or .xlsx)", truncated: false });
    }
  }

  function findKnown(name: string): Restaurant | null {
    const n = name.trim().toLowerCase();
    if (n.length < 2) return null;
    let partial: Restaurant | null = null;
    for (const r of restaurants) {
      const rn = r.name.toLowerCase();
      if (rn === n) return r;
      if (!partial && n.length >= 4 && (rn.includes(n) || n.includes(rn))) partial = r;
    }
    return partial;
  }

  async function callPowerBITool(name: string, inputObj: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch("/api/assistant/powerbi", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, input: inputObj }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.message || data.error || "Power BI tool failed");
    }
    return data;
  }

  async function runTool(name: string, inputObj: Record<string, unknown>): Promise<ToolRun> {
    if (POWERBI_TOOLS.has(name)) {
      const data = await callPowerBITool(name, inputObj);
      if (name === "run_dax_query") {
        const rows = Array.isArray(data.rows) ? (data.rows as Record<string, unknown>[]) : [];
        const columns = Array.isArray(data.columns) ? data.columns.filter((c): c is string => typeof c === "string") : columnsFor(rows, []);
        const resultId = String(data.result_id || "");
        powerResultsRef.current.set(resultId, {
          result_id: resultId,
          columns,
          rows,
          row_count: Number(data.row_count || rows.length),
          truncated: data.truncated === true,
        });
        const { rows: _rows, ...forModel } = data;
        return { content: JSON.stringify(forModel).slice(0, 60000) };
      }
      return { content: JSON.stringify(data).slice(0, 60000) };
    }

    if (name === "display_result") {
      const resultId = String(inputObj.result_id || "");
      const result = powerResultsRef.current.get(resultId);
      if (!result) return { content: JSON.stringify({ error: "Unknown result_id. Run a Power BI query first." }) };
      const block = makeDisplayBlock(inputObj, result);
      return {
        content: JSON.stringify({ ok: true, displayed: block.as, rows_shown: block.rows.length, row_count: block.rowCount }),
        block,
      };
    }

    if (name === "navigate") {
      const page = String(inputObj.page || "dashboard");
      router.push(`/${page}`);
      return { content: `Navigated to ${page}.`, terminal: true };
    }

    if (name === "apply_filter") {
      const i = inputObj as {
        page?: string; cuisine?: string; cuisines?: string[]; borough?: string; boroughs?: string[];
        text?: string; recommendedOnly?: boolean; existingCustomerOnly?: boolean; names?: string[];
      };
      const page = i.page === "map" ? "map" : "leads";
      if (i.names && i.names.length) {
        const wanted = i.names.map((n) => n.trim().toLowerCase()).filter(Boolean);
        const ids: string[] = [];
        for (const r of restaurants) {
          const rn = r.name.toLowerCase();
          if (wanted.some((w) => rn.includes(w) || w.includes(rn))) ids.push(r.id);
        }
        setFocusIds(ids);
        router.push(`/${page}`);
        return { content: JSON.stringify({ matched: ids.length, fromList: wanted.length }), terminal: true };
      }
      setFocusIds(null);

      const allBoroughs = Array.from(new Set(restaurants.map((r) => r.borough)));
      const notes: string[] = [];
      const textBits: string[] = [];
      if (i.text) textBits.push(i.text);

      const cuisineInputs = [i.cuisine, ...(i.cuisines ?? [])].filter(Boolean) as string[];
      const boroughInputs = [i.borough, ...(i.boroughs ?? [])].filter(Boolean) as string[];

      const cuisineSet = new Set<string>();
      for (const ci of cuisineInputs) {
        const rc = resolveCuisine(ci);
        if (rc.value) {
          cuisineSet.add(rc.value);
          if (rc.note) notes.push(rc.note);
        } else {
          textBits.push(ci);
          notes.push(`There's no "${ci}" category, so I searched for it as text`);
        }
      }

      const boroughSet = new Set<string>();
      for (const bi of boroughInputs) {
        const rb = resolveAreaOrBorough(bi, allBoroughs);
        if (rb.borough) {
          boroughSet.add(rb.borough);
          if (rb.note) notes.push(rb.note);
        } else if (rb.text) {
          textBits.push(rb.text);
          if (rb.note) notes.push(rb.note);
        }
      }

      let text = textBits.length ? textBits.join(" ") : undefined;
      if (boroughSet.size === 0 && text) {
        const rb = resolveAreaOrBorough(text, allBoroughs);
        if (rb.borough) {
          boroughSet.add(rb.borough);
          if (rb.note) notes.push(rb.note);
          text = undefined;
        }
      }
      if (boroughSet.size > 0 && text) {
        const rt = resolveAreaOrBorough(text, allBoroughs);
        if (rt.borough && boroughSet.has(rt.borough)) text = undefined;
      }

      const filter: AppliedFilter = {
        cuisines: cuisineSet.size ? Array.from(cuisineSet) : undefined,
        boroughs: boroughSet.size ? Array.from(boroughSet) : undefined,
        text,
        recommendedOnly: i.recommendedOnly,
        existingCustomerOnly: i.existingCustomerOnly,
      };
      filter.includeExcluded = Boolean(filter.cuisines?.length || filter.text);

      const count = restaurants.filter((r) => matchesFilter(r, filter)).length;
      setViewFilter(filter);
      router.push(`/${page}`);

      const uniqueNotes = Array.from(new Set(notes));
      const noteStr = uniqueNotes.length ? ` (${uniqueNotes.join("; ")})` : "";
      if (count === 0) {
        return { content: `I couldn't find any ${describeFilter(filter)}${noteStr}. Nothing to show; try broadening the filter.`, terminal: true };
      }
      return { content: `Showing ${count} ${describeFilter(filter)} on the ${page}${noteStr}.`, terminal: true };
    }

    if (name === "get_stats") {
      const f = funnelCounts(restaurants);
      const groupBy = inputObj.groupBy as string | undefined;
      let breakdown: Record<string, number> | undefined;
      if (groupBy === "borough" || groupBy === "cuisine") {
        const key = groupBy === "borough" ? "borough" : "cuisineType";
        const counts: Record<string, number> = {};
        for (const r of restaurants) if (!r.excluded) counts[r[key]] = (counts[r[key]] ?? 0) + 1;
        breakdown = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15));
      }
      return { content: JSON.stringify({ ...f, breakdown }) };
    }

    if (name === "search_restaurants") {
      const i = inputObj as {
        text?: string; borough?: string; cuisine?: string;
        recommendedOnly?: boolean; existingCustomerOnly?: boolean; minScore?: number; limit?: number;
      };
      const text = (i.text || "").toLowerCase();
      const limit = Math.min(Math.max(i.limit ?? 15, 1), 25);
      const filtered = restaurants.filter((r) => {
        if (i.borough && r.borough.toLowerCase() !== i.borough.toLowerCase()) return false;
        if (i.cuisine && !r.cuisineType.toLowerCase().includes(i.cuisine.toLowerCase())) return false;
        if (i.recommendedOnly && !r.recommended) return false;
        if (i.existingCustomerOnly && !r.existingCustomer) return false;
        if (typeof i.minScore === "number" && r.leadScore < i.minScore) return false;
        if (text && !`${r.name} ${r.borough} ${r.cuisineType} ${r.postcode}`.toLowerCase().includes(text)) return false;
        return true;
      });
      filtered.sort((a, b) => b.leadScore - a.leadScore);
      const results = filtered.slice(0, limit).map((r) => ({
        name: r.name, borough: r.borough, cuisine: r.cuisineType, priceTier: r.priceTier,
        leadScore: r.leadScore, recommended: r.recommended, existingCustomer: r.existingCustomer, email: r.email ?? null,
      }));
      return { content: JSON.stringify({ total: filtered.length, returned: results.length, results }) };
    }

    if (name === "generate_emails") {
      const i = inputObj as {
        names?: string[]; cuisine?: string; borough?: string; text?: string; recommendedOnly?: boolean; limit?: number;
      };
      const limit = Math.min(Math.max(i.limit ?? 20, 1), 50);
      const wantNames = (i.names || []).map((n) => n.toLowerCase());
      const text = (i.text || "").toLowerCase();
      const recommendedOnly = i.recommendedOnly ?? wantNames.length === 0;
      const targets = restaurants
        .filter((r) => {
          if (r.excluded || r.existingCustomer) return false;
          if (wantNames.length) return wantNames.some((n) => r.name.toLowerCase().includes(n));
          if (recommendedOnly && !r.recommended) return false;
          if (i.cuisine && !r.cuisineType.toLowerCase().includes(i.cuisine.toLowerCase())) return false;
          if (i.borough && r.borough.toLowerCase() !== i.borough.toLowerCase()) return false;
          if (text && !`${r.name} ${r.borough} ${r.postcode}`.toLowerCase().includes(text)) return false;
          return true;
        })
        .sort((a, b) => b.leadScore - a.leadScore)
        .slice(0, limit);
      const patches: Record<string, Partial<Restaurant>> = {};
      for (const r of targets) patches[r.id] = { outreachStatus: "draft_ready" };
      updateMany(patches);
      router.push("/emails");
      return { content: `Created ${targets.length} email draft${targets.length === 1 ? "" : "s"}; opening the Email centre to review.`, terminal: true };
    }

    if (name === "clear_drafts") {
      const drafts = restaurants.filter((r) => r.outreachStatus === "draft_ready");
      const patches: Record<string, Partial<Restaurant>> = {};
      for (const r of drafts) patches[r.id] = { outreachStatus: "not_contacted" };
      updateMany(patches);
      return { content: `Cleared ${drafts.length} draft${drafts.length === 1 ? "" : "s"}.`, terminal: true };
    }

    if (name === "scan_openings") {
      const i = inputObj as { area?: string };
      const res = await fetch("/api/scan-openings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ area: i.area }),
      });
      const data = await res.json();
      if (data.error) return { content: `Couldn't scan the web (${data.error}${data.message ? `: ${data.message}` : ""}).`, terminal: true };
      const openings: ScannedOpening[] = data.openings || [];
      const { toAdd, toUpdate, total } = prepareOpenings(openings, restaurants);
      if (toAdd.length) addRestaurants(toAdd);
      if (Object.keys(toUpdate).length) updateMany(toUpdate);
      router.push("/leads?openings=1");
      return { content: `Scanned the web and found ${total} new / upcoming opening${total === 1 ? "" : "s"}${i.area ? ` around ${i.area}` : ""}; added to the New openings view in Leads.`, terminal: true };
    }

    if (name === "add_customers") {
      if (loading) return { content: "The venue database is still loading. Give me a couple of seconds, then ask again so I can match against known venues.", terminal: true };
      const list = (inputObj.customers as Record<string, unknown>[]) || [];
      const skipUnknown = inputObj.skipUnknown === true;
      const toAdd: Restaurant[] = [];
      const patches: Record<string, Partial<Restaurant>> = {};
      const seen = new Set<string>();
      const leftUnknown: string[] = [];
      let matched = 0, created = 0, skipped = 0;
      for (const c of list) {
        const cname = String(c.name || "").trim();
        if (!cname) continue;
        const key = cname.toLowerCase();
        if (seen.has(key)) { skipped++; continue; }
        seen.add(key);
        const isCustomer = c.existingCustomer !== false;
        const known = findKnown(cname);
        if (known) {
          patches[known.id] = {
            existingCustomer: isCustomer,
            outreachStatus: isCustomer ? "converted" : "not_contacted",
            ...(c.email ? { email: String(c.email) } : {}),
            ...(c.phone ? { phone: String(c.phone) } : {}),
            ...(c.website ? { website: String(c.website) } : {}),
          };
          matched++;
        } else if (skipUnknown) {
          leftUnknown.push(cname);
        } else {
          const tier = Math.min(Math.max(Number(c.priceTier) || 3, 1), 4) as PriceTier;
          toAdd.push(
            makeRestaurant({
              name: cname,
              address: String(c.address || ""),
              postcode: String(c.postcode || ""),
              borough: String(c.borough || "London"),
              latitude: 51.5095,
              longitude: -0.1265,
              cuisineType: String(c.cuisineType || "Other / Unknown"),
              businessType: "Restaurant",
              priceTier: tier,
              email: c.email ? String(c.email) : undefined,
              phone: c.phone ? String(c.phone) : undefined,
              website: c.website ? String(c.website) : undefined,
              existingCustomer: isCustomer,
            })
          );
          created++;
        }
      }
      if (toAdd.length) addRestaurants(toAdd);
      if (Object.keys(patches).length) updateMany(patches);
      if (skipUnknown) {
        const left = leftUnknown.length;
        return {
          content: `Matched ${matched} to existing venues and flagged them as customers. Left ${left} unknown name${left === 1 ? "" : "s"} as-is${left ? ` (${leftUnknown.slice(0, 8).join(", ")}${left > 8 ? "..." : ""})` : ""}.`,
          terminal: true,
        };
      }
      const total = matched + created;
      return {
        content: `Added ${total} customer${total === 1 ? "" : "s"} (${matched} matched to known venues, ${created} new)${skipped ? `; skipped ${skipped} duplicate name${skipped === 1 ? "" : "s"}` : ""}.`,
        terminal: true,
      };
    }

    if (name === "schedule_visit" || name === "book_followup") {
      if (!me) return { content: "You need to be signed in to book a visit." };
      const venue = resolveVenue(String(inputObj.venue ?? ""));
      if (!venue) return { content: `I couldn't find a venue called "${String(inputObj.venue ?? "")}".` };
      const dateKey = String(inputObj.date ?? "").trim() || toDateKey(new Date());
      const startTime = inputObj.time ? String(inputObj.time) : undefined;
      const isFollowup = name === "book_followup";
      addMeeting(
        buildScheduledMeeting({
          repId: me.id,
          repName: me.name,
          venue,
          dateKey,
          type: (inputObj.type as MeetingType) ?? "in_person",
          startTime,
          source: isFollowup ? "followup" : "rep",
          reason: isFollowup ? (inputObj.reason ? String(inputObj.reason) : "Follow-up") : undefined,
          notes: inputObj.notes ? String(inputObj.notes) : undefined,
        }),
      );
      return {
        content: `Booked a ${isFollowup ? "follow-up" : "visit"} to ${venue.name} on ${fmtDateKeyShort(dateKey)}${startTime ? ` at ${startTime}` : ""}.`,
        terminal: true,
      };
    }

    if (name === "send_samples") {
      if (!me) return { content: "You need to be signed in." };
      const venue = resolveVenue(String(inputObj.venue ?? ""));
      if (!venue) return { content: `I couldn't find a venue called "${String(inputObj.venue ?? "")}".` };
      const dateKey = String(inputObj.date ?? "").trim() || toDateKey(addDays(new Date(), 7));
      const note: ContactNote = {
        id: `note_${Date.now()}`,
        author: me.name,
        text: inputObj.notes ? String(inputObj.notes) : "Samples sent.",
        outcome: "samples_sent",
        at: new Date().toISOString(),
        repId: me.id,
      };
      updateRestaurant(venue.id, { contactLog: [...(venue.contactLog ?? []), note] });
      addMeeting(
        buildSamplesFollowUp({
          repId: me.id,
          repName: me.name,
          venue,
          dateKey,
          notes: inputObj.notes ? String(inputObj.notes) : undefined,
        }),
      );
      return { content: `Logged samples sent to ${venue.name} and booked a follow-up on ${fmtDateKeyShort(dateKey)}.`, terminal: true };
    }

    if (name === "log_activity") {
      if (!me) return { content: "You need to be signed in." };
      const venue = resolveVenue(String(inputObj.venue ?? ""));
      if (!venue) return { content: `I couldn't find a venue called "${String(inputObj.venue ?? "")}".` };
      const text = String(inputObj.note ?? "").trim();
      if (!text) return { content: "What should the note say?" };
      const note: ContactNote = {
        id: `note_${Date.now()}`,
        author: me.name,
        text,
        outcome: (inputObj.outcome as ContactOutcome) ?? "other",
        at: new Date().toISOString(),
        repId: me.id,
      };
      updateRestaurant(venue.id, { contactLog: [...(venue.contactLog ?? []), note] });
      return { content: `Logged a note on ${venue.name}.`, terminal: true };
    }

    if (name === "record_meeting") {
      const venue = resolveVenue(String(inputObj.venue ?? ""));
      if (!venue) return { content: `I couldn't find a venue called "${String(inputObj.venue ?? "")}".` };
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("ltp:record-meeting", { detail: { venueId: venue.id } }));
      }
      setOpen(false);
      return { content: `Opening the meeting recorder for ${venue.name}.`, terminal: true };
    }

    return { content: `Unknown tool: ${name}` };
  }

  async function send(overrideText?: string) {
    const text = (overrideText ?? input).trim();
    const attachment = attached;
    if ((!text && !attachment) || busy) return;
    setInput("");
    setAttached(null);

    let apiContent = text || (attachment ? `Use the attached file "${attachment.name}".` : "");
    if (attachment) {
      apiContent += `\n\n--- Attached file "${attachment.name}" ---\n${attachment.text}`;
      if (attachment.truncated) apiContent += `\n--- (file truncated to ${MAX_FILE_CHARS} characters) ---`;
    }

    const userMsg: Msg = { role: "user", content: apiContent, display: text || "Attached file", file: attachment?.name };
    let convo: Msg[] = [...messages, userMsg];
    setMessages(convo);
    setBusy(true);

    const context = `Page: ${pathname}${typeof window !== "undefined" ? window.location.search : ""}.${focusIds ? ` A file-match focus of ${focusIds.length} venues is currently active.` : ""}`;

    try {
      for (let i = 0; i < 8; i++) {
        const res = await fetch("/api/assistant", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: sanitizeForApi(convo), context }),
        });
        const data = await res.json();

        if (data.error === "no_api_key") {
          convo = [...convo, { role: "assistant", content: "I'm not connected to an LLM yet. Add `ANTHROPIC_API_KEY` to `.env.local` and restart the dev server." }];
          setMessages(convo);
          break;
        }
        if (data.error) {
          convo = [...convo, { role: "assistant", content: `Something went wrong (${data.error}${data.message ? `: ${data.message}` : ""}).` }];
          setMessages(convo);
          break;
        }

        const blocks: Block[] = data.content;
        convo = [...convo, { role: "assistant", content: blocks }];
        setMessages(convo);

        const toolUses = toolUsesOf(blocks);
        if (toolUses.length === 0) break;

        const results: Block[] = [];
        const visibleBlocks: LumenVizBlock[] = [];
        const runs: ToolRun[] = [];
        for (const tu of toolUses) {
          // Write actions propose first — the rep must tap Accept before we run.
          if (CONFIRM_TOOLS.has(tu.name)) {
            const ok = await requestConfirm(tu.name, tu.input);
            if (!ok) {
              const declined: ToolRun = { content: "The rep declined this action.", terminal: true };
              runs.push(declined);
              results.push({ type: "tool_result", tool_use_id: tu.id, content: declined.content });
              continue;
            }
          }
          let run: ToolRun;
          try {
            run = await runTool(tu.name, tu.input);
          } catch (err) {
            run = { content: `Tool error: ${err instanceof Error ? err.message : String(err)}` };
          }
          runs.push(run);
          if (run.block) visibleBlocks.push(run.block);
          results.push({ type: "tool_result", tool_use_id: tu.id, content: run.content });
        }

        convo = [...convo, { role: "user", content: results }];
        if (visibleBlocks.length) {
          convo = [...convo, { role: "assistant", content: "", blocks: visibleBlocks, local: true }];
        }
        setMessages(convo);

        if (toolUses.every((tu, idx) => TERMINAL_TOOLS.has(tu.name) || runs[idx]?.terminal)) {
          convo = [...convo, { role: "assistant", content: runs.map((r) => r.content).join(" ") }];
          setMessages(convo);
          break;
        }
      }
    } catch {
      convo = [...convo, { role: "assistant", content: "Network error. Please try again." }];
      setMessages(convo);
    } finally {
      setBusy(false);
    }
  }

  const panelClass =
    variant === "mobile"
      ? "fixed inset-x-3 bottom-3 top-20 z-[1200] flex flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200"
      : expanded
        ? "fixed inset-6 z-[1000] flex flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200"
        : "fixed bottom-5 right-5 z-[1000] flex h-[38rem] w-[29rem] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200";

  const launcherClass =
    variant === "mobile"
      ? "fixed left-4 top-[126px] z-[1000] flex h-11 items-center gap-2 rounded-full bg-slate-950 px-3 text-sm font-semibold text-white shadow-lg active:scale-95"
      : "fixed bottom-5 right-5 z-[1000] flex h-14 w-14 items-center justify-center rounded-full bg-slate-950 text-white shadow-lg transition hover:bg-slate-800";

  return (
    <>
      {!open && (
        <button onClick={() => setOpen(true)} className={launcherClass} aria-label="Open Lumen">
          <LumenMark className={variant === "mobile" ? "h-6 w-6" : "h-8 w-8"} />
          {variant === "mobile" && <span>Lumen</span>}
        </button>
      )}

      {open && (
        <div
          className={panelClass}
          style={
            variant === "mobile"
              ? {
                  top: keyboard.inset ? keyboard.top + 12 : undefined,
                  bottom: keyboard.inset ? keyboard.inset + 12 : undefined,
                  transition: "top 120ms ease-out, bottom 120ms ease-out",
                }
              : undefined
          }
        >
          <div className="flex items-center justify-between bg-slate-950 px-4 py-3 text-white">
            <div className="flex items-center gap-2">
              <LumenMark className="h-7 w-7" />
              <div>
                <p className="text-sm font-semibold leading-tight">Lumen</p>
                <p className="text-[11px] leading-tight text-white/55">Prospector + Power BI</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {variant !== "mobile" && (
                <button
                  onClick={() => setExpanded((v) => !v)}
                  aria-label={expanded ? "Shrink Lumen" : "Expand Lumen"}
                  title={expanded ? "Shrink" : "Expand for a bigger view"}
                  className="rounded-full p-1 text-white/75 hover:bg-white/10 hover:text-white"
                >
                  {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                </button>
              )}
              <button onClick={() => setOpen(false)} aria-label="Close Lumen" className="rounded-full p-1 text-white/75 hover:bg-white/10 hover:text-white">
                <X size={18} />
              </button>
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto bg-slate-50 p-4">
            {messages.length === 0 && (
              <div className="space-y-3">
                <div className="rounded-xl bg-white p-4 text-sm text-slate-600 ring-1 ring-slate-200">
                  <div className="mb-3 flex items-center gap-2 text-slate-900">
                    <Sparkles size={16} className="text-blue-600" />
                    <span className="font-semibold">Ask Lumen</span>
                  </div>
                  <div className="grid gap-2">
                    {SUGGESTIONS.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        onClick={() => void send(suggestion)}
                        className="rounded-lg bg-slate-100 px-3 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-200"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {messages.map((m, idx) => {
              if (isToolResultMsg(m)) return null;
              // Working turns (tool calls + interim narration) stay hidden;
              // the user only sees the final answer and any rendered views.
              if (m.role === "assistant" && toolUsesOf(m.content).length > 0) return null;
              const txt = m.role === "user" ? (m.display ?? textOf(m.content)) : textOf(m.content);
              const hasBlocks = Boolean(m.blocks?.length);
              if (!txt && !m.file && !hasBlocks) return null;
              return (
                <div key={idx} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                  <div className={`max-w-[92%] space-y-2 ${hasBlocks ? "w-full" : ""}`}>
                    {(txt || m.file) && (
                      <div className={`rounded-2xl px-3 py-2 text-sm ${m.role === "user" ? "bg-blue-600 text-white" : "bg-white text-slate-800 ring-1 ring-slate-200"}`}>
                        {m.file && <p className={`mb-1 text-xs ${m.role === "user" ? "text-white/80" : "text-slate-400"}`}>Attached: {m.file}</p>}
                        {txt && (m.role === "assistant" ? <LumenMarkdown text={txt} /> : <p className="whitespace-pre-wrap">{txt}</p>)}
                      </div>
                    )}
                    {m.blocks?.map((block, blockIndex) => (
                      <LumenVisualization key={blockIndex} block={block} expanded={expanded} />
                    ))}
                  </div>
                </div>
              );
            })}
            {busy && <p className="text-xs text-slate-400">Lumen is working...</p>}
          </div>

          {pending && (
            <div className="border-t border-slate-200 bg-indigo-50 px-3 py-3">
              <p className="mb-2 text-xs font-medium text-indigo-900">{pending.summary}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => resolveConfirm(true)}
                  className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white active:scale-95"
                >
                  <Check size={14} /> Accept
                </button>
                <button
                  type="button"
                  onClick={() => resolveConfirm(false)}
                  className="rounded-lg bg-white px-3 py-2 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 active:scale-95"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {voice.listening && (
            <div className="border-t border-slate-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate">{voice.interim || "Listening..."}</span>
                <div className="flex shrink-0 gap-1">
                  <button type="button" onClick={voice.restart} className="rounded-md bg-white px-2 py-1 font-medium text-blue-700">Restart</button>
                  <button type="button" onClick={voice.cancel} className="rounded-md bg-white px-2 py-1 font-medium text-blue-700">Cancel</button>
                  <button type="button" onClick={voice.toggle} className="rounded-md bg-blue-600 px-2 py-1 font-medium text-white">Send</button>
                </div>
              </div>
            </div>
          )}

          {voice.error && !voice.listening && (
            <div className="border-t border-slate-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{voice.error}</div>
          )}

          {attached && (
            <div className="flex items-center justify-between gap-2 border-t border-slate-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <span className="truncate">Attached: {attached.name}{attached.truncated ? " (truncated)" : ""}</span>
              <button onClick={() => setAttached(null)} className="font-medium hover:underline">remove</button>
            </div>
          )}

          <div className="flex items-end gap-2 border-t border-slate-200 p-3">
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.json,.xlsx,.xls" className="hidden" onChange={onFile} />
            <button
              onClick={() => fileRef.current?.click()}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200"
              aria-label="Attach file"
              title="Attach file"
            >
              <Paperclip size={17} />
            </button>
            {voice.supported && (
              <button
                onClick={voice.toggle}
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${voice.listening ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
                aria-label={voice.listening ? "Stop voice input" : "Start voice input"}
                title={voice.listening ? "Stop voice input" : "Start voice input"}
              >
                <Mic size={17} />
              </button>
            )}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              rows={1}
              placeholder={attached ? "Add an instruction for the file..." : "Ask Lumen..."}
              className="max-h-28 min-h-10 flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
            />
            <button onClick={() => void send()} disabled={busy || (!input.trim() && !attached)} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
              <Send size={17} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
