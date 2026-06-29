"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Bot, Paperclip, Send, X } from "lucide-react";
import { useRestaurants } from "@/lib/store";
import { funnelCounts, makeRestaurant } from "@/lib/mock-data";
import { prepareOpenings, type ScannedOpening } from "@/lib/openings";
import { describeFilter, matchesFilter, resolveAreaOrBorough, resolveCuisine, type AppliedFilter } from "@/lib/filtering";
import type { PriceTier, Restaurant } from "@/lib/types";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };
// `display`/`file` are local-only (stripped before sending to the API).
type Msg = { role: "user" | "assistant"; content: string | Block[]; display?: string; file?: string };

const MAX_FILE_CHARS = 60000;

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

// Strip local-only fields AND guarantee every assistant `tool_use` is followed
// by a user message with matching `tool_result` blocks (the API 400s otherwise).
// Injects stub results for any dangling tool calls so a bad state can't wedge
// the chat.
function sanitizeForApi(msgs: Msg[]): { role: "user" | "assistant"; content: string | Block[] }[] {
  const src = msgs.map((m) => ({ role: m.role, content: m.content }));
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
      if (next && next.role === "user" && Array.isArray(next.content)) {
        src[k + 1] = { role: "user", content: [...next.content, ...stubs] }; // merge into the following user msg
      } else {
        out.push({ role: "user", content: stubs }); // insert a results message
      }
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

// Tools that change the UI directly — after these we don't need a follow-up
// model call, so we confirm locally for instant feedback.
const TERMINAL_TOOLS = new Set(["navigate", "apply_filter", "clear_drafts", "generate_emails", "add_customers", "scan_openings"]);

export function Assistant() {
  const { restaurants, loading, addRestaurants, updateMany, focusIds, setFocusIds, setViewFilter } = useRestaurants();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [attached, setAttached] = useState<{ name: string; text: string; truncated: boolean } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    try {
      const raw = await readFileAsText(file);
      const truncated = raw.length > MAX_FILE_CHARS;
      setAttached({ name: file.name, text: truncated ? raw.slice(0, MAX_FILE_CHARS) : raw, truncated });
    } catch {
      setAttached({ name: file.name, text: "(could not read this file — try CSV or .xlsx)", truncated: false });
    }
  }

  function findKnown(name: string): Restaurant | null {
    const n = name.trim().toLowerCase();
    if (n.length < 2) return null;
    let partial: Restaurant | null = null;
    for (const r of restaurants) {
      const rn = r.name.toLowerCase();
      if (rn === n) return r; // exact match wins
      // Only allow fuzzy matching for reasonably long names to avoid mis-matches.
      if (!partial && n.length >= 4 && (rn.includes(n) || n.includes(rn))) partial = r;
    }
    return partial;
  }

  async function runTool(name: string, inputObj: Record<string, unknown>): Promise<string> {
    if (name === "navigate") {
      const page = String(inputObj.page || "dashboard");
      router.push(`/${page}`);
      return `Navigated to ${page}.`;
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
        return JSON.stringify({ matched: ids.length, fromList: wanted.length });
      }
      setFocusIds(null);

      // Resolve free wording (one or MANY cuisines/areas) to REAL categories so
      // the view never comes up empty on a near-miss; explain any substitution.
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
          notes.push(`There’s no “${ci}” category, so I searched for it as text`);
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
      // If no borough resolved but free text is an area, use its borough.
      if (boroughSet.size === 0 && text) {
        const rb = resolveAreaOrBorough(text, allBoroughs);
        if (rb.borough) {
          boroughSet.add(rb.borough);
          if (rb.note) notes.push(rb.note);
          text = undefined;
        }
      }
      // Drop redundant area-text already covered by a selected borough.
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
      // An explicit category/text request should show poor-fit venues too.
      filter.includeExcluded = Boolean(filter.cuisines?.length || filter.text);

      const count = restaurants.filter((r) => matchesFilter(r, filter)).length;
      setViewFilter(filter);
      router.push(`/${page}`);

      const uniqueNotes = Array.from(new Set(notes));
      const noteStr = uniqueNotes.length ? ` (${uniqueNotes.join("; ")})` : "";
      if (count === 0) {
        return `I couldn't find any ${describeFilter(filter)}${noteStr}. Nothing to show — try broadening the filter.`;
      }
      return `Showing ${count} ${describeFilter(filter)} on the ${page}${noteStr}.`;
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
      return JSON.stringify({ ...f, breakdown });
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
      return JSON.stringify({ total: filtered.length, returned: results.length, results });
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
      return `Created ${targets.length} email draft${targets.length === 1 ? "" : "s"} — opening the Email centre to review.`;
    }

    if (name === "clear_drafts") {
      const drafts = restaurants.filter((r) => r.outreachStatus === "draft_ready");
      const patches: Record<string, Partial<Restaurant>> = {};
      for (const r of drafts) patches[r.id] = { outreachStatus: "not_contacted" };
      updateMany(patches);
      return `Cleared ${drafts.length} draft${drafts.length === 1 ? "" : "s"}.`;
    }

    if (name === "scan_openings") {
      const i = inputObj as { area?: string };
      const res = await fetch("/api/scan-openings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ area: i.area }),
      });
      const data = await res.json();
      if (data.error) return `Couldn't scan the web (${data.error}${data.message ? `: ${data.message}` : ""}).`;
      const openings: ScannedOpening[] = data.openings || [];
      const { toAdd, toUpdate, total } = prepareOpenings(openings, restaurants);
      if (toAdd.length) addRestaurants(toAdd);
      if (Object.keys(toUpdate).length) updateMany(toUpdate);
      router.push("/new-openings");
      return `Scanned the web and found ${total} new / upcoming opening${total === 1 ? "" : "s"}${i.area ? ` around ${i.area}` : ""} — added to New Openings.`;
    }

    if (name === "add_customers") {
      if (loading) return "The venue database is still loading — give me a couple of seconds, then ask again so I can match against known venues.";
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
          // Lightweight override on the REAL venue — no duplicate record.
          patches[known.id] = {
            existingCustomer: isCustomer,
            outreachStatus: isCustomer ? "converted" : "not_contacted",
            ...(c.email ? { email: String(c.email) } : {}),
            ...(c.phone ? { phone: String(c.phone) } : {}),
            ...(c.website ? { website: String(c.website) } : {}),
          };
          matched++;
        } else if (skipUnknown) {
          // User asked to only match existing venues and leave unknown ones.
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
        return `Matched ${matched} to existing venues and flagged them as customers. Left ${left} unknown name${left === 1 ? "" : "s"} as-is${left ? ` (${leftUnknown.slice(0, 8).join(", ")}${left > 8 ? "…" : ""})` : ""}.`;
      }
      const total = matched + created;
      return `Added ${total} customer${total === 1 ? "" : "s"} (${matched} matched to known venues, ${created} new)${skipped ? `; skipped ${skipped} duplicate name${skipped === 1 ? "" : "s"}` : ""}.`;
    }

    return `Unknown tool: ${name}`;
  }

  async function send() {
    const text = input.trim();
    if ((!text && !attached) || busy) return;
    setInput("");

    // Build the message: typed text + (optional) file contents for the model,
    // but keep a short display string for the chat bubble.
    let apiContent = text || (attached ? `Use the attached file "${attached.name}".` : "");
    if (attached) {
      apiContent += `\n\n--- Attached file "${attached.name}" ---\n${attached.text}`;
      if (attached.truncated) apiContent += `\n--- (file truncated to ${MAX_FILE_CHARS} characters) ---`;
    }
    const userMsg: Msg = { role: "user", content: apiContent, display: text || "(no message)", file: attached?.name };
    setAttached(null);

    let convo: Msg[] = [...messages, userMsg];
    setMessages(convo);
    setBusy(true);

    const context = `Page: ${pathname}${typeof window !== "undefined" ? window.location.search : ""}.${focusIds ? ` A file-match focus of ${focusIds.length} venues is currently active.` : ""}`;

    try {
      for (let i = 0; i < 6; i++) {
        const res = await fetch("/api/assistant", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // Sanitize: strip local fields + guarantee tool_use/tool_result pairing.
          body: JSON.stringify({ messages: sanitizeForApi(convo), context }),
        });
        const data = await res.json();

        if (data.error === "no_api_key") {
          convo = [...convo, { role: "assistant", content: "I'm not connected to an LLM yet. Add your `ANTHROPIC_API_KEY` to `.env.local` and restart the dev server." }];
          setMessages(convo); break;
        }
        if (data.error) {
          convo = [...convo, { role: "assistant", content: `Something went wrong (${data.error}${data.message ? `: ${data.message}` : ""}).` }];
          setMessages(convo); break;
        }

        const blocks: Block[] = data.content;
        convo = [...convo, { role: "assistant", content: blocks }];
        setMessages(convo);

        // Run tools whenever tool_use blocks are present — do NOT rely on
        // stop_reason (a max_tokens-truncated reply can still carry a tool_use,
        // and breaking here would leave it dangling → next request 400s).
        const toolUses = toolUsesOf(blocks);
        if (toolUses.length === 0) break;

        const results: Block[] = [];
        for (const tu of toolUses) {
          let content: string;
          try {
            content = await runTool(tu.name, tu.input);
          } catch (err) {
            content = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
          }
          results.push({ type: "tool_result", tool_use_id: tu.id, content });
        }
        convo = [...convo, { role: "user", content: results }]; // keep history valid
        setMessages(convo);

        // If every tool was a UI action, confirm locally and skip the extra
        // model round-trip (faster). Otherwise loop so the model can read the
        // tool results (search / stats) and answer.
        if (toolUses.every((tu) => TERMINAL_TOOLS.has(tu.name))) {
          convo = [...convo, { role: "assistant", content: results.map((r) => (r.type === "tool_result" ? r.content : "")).join(" ") }];
          setMessages(convo);
          break;
        }
      }
    } catch {
      convo = [...convo, { role: "assistant", content: "Network error — please try again." }];
      setMessages(convo);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {!open && (
        <button onClick={() => setOpen(true)} className="fixed bottom-5 right-5 z-[1000] flex h-14 w-14 items-center justify-center rounded-full bg-brand-500 text-white shadow-lg transition hover:bg-brand-600" aria-label="Open assistant">
          <Bot size={24} />
        </button>
      )}

      {open && (
        <div className="fixed bottom-5 right-5 z-[1000] flex h-[34rem] w-[26rem] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200">
          <div className="flex items-center justify-between bg-brand-500 px-4 py-3 text-white">
            <div className="flex items-center gap-2"><Bot size={18} /><span className="text-sm font-semibold">LTP Assistant</span></div>
            <button onClick={() => setOpen(false)} aria-label="Close"><X size={18} /></button>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto bg-slate-50 p-4">
            {messages.length === 0 && (
              <div className="rounded-lg bg-white p-3 text-sm text-slate-500 ring-1 ring-slate-200">
                Hi! I can search, filter views, add customers, and draft emails. You can also attach a file (📎) and say:
                <ul className="mt-2 list-disc pl-5 text-xs text-slate-500">
                  <li>“Add all customers from this file”</li>
                  <li>“Pull up all restaurants that match this file”</li>
                  <li>“Draft 7 emails for the best fits in Shoreditch”</li>
                </ul>
              </div>
            )}
            {messages.map((m, idx) => {
              if (isToolResultMsg(m)) return null;
              const txt = m.role === "user" ? (m.display ?? textOf(m.content)) : textOf(m.content);
              const actions = toolUsesOf(m.content);
              if (!txt && actions.length === 0 && !m.file) return null;
              return (
                <div key={idx} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                  <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${m.role === "user" ? "bg-brand-500 text-white" : "bg-white text-slate-800 ring-1 ring-slate-200"}`}>
                    {m.file && <p className={`mb-1 text-xs ${m.role === "user" ? "text-white/80" : "text-slate-400"}`}>📎 {m.file}</p>}
                    {actions.length > 0 && <p className="mb-1 text-xs italic text-slate-400">⚙ {actions.map((a) => a.name).join(", ")}</p>}
                    {txt && <p className="whitespace-pre-wrap">{txt}</p>}
                  </div>
                </div>
              );
            })}
            {busy && <p className="text-xs text-slate-400">Thinking…</p>}
          </div>

          {attached && (
            <div className="flex items-center justify-between gap-2 border-t border-slate-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <span className="truncate">📎 {attached.name}{attached.truncated ? " (truncated)" : ""}</span>
              <button onClick={() => setAttached(null)} className="font-medium hover:underline">remove</button>
            </div>
          )}

          <div className="flex items-center gap-2 border-t border-slate-200 p-3">
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.json,.xlsx,.xls" className="hidden" onChange={onFile} />
            <button onClick={() => fileRef.current?.click()} className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200" aria-label="Attach file" title="Attach a CSV / Excel / text file">
              <Paperclip size={16} />
            </button>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") send(); }}
              placeholder={attached ? "Add an instruction for the file…" : "Ask, or attach a file…"}
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
            />
            <button onClick={send} disabled={busy} className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-50">
              <Send size={16} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
