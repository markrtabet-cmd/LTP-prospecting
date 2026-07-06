"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Globe } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { LeadBadge, OutreachBadge, PriceTag, RecommendBadge } from "@/components/StatusBadge";
import { MultiSelect } from "@/components/MultiSelect";
import { prepareOpenings, type ScannedOpening } from "@/lib/openings";
import { useRestaurants } from "@/lib/store";
import { getRegion, isLondon } from "@/lib/locations";

type OpeningFilter = "all" | "new_this_week" | "opening_soon";

export default function NewOpeningsPage() {
  const { restaurants, addRestaurants, updateMany, updateRestaurant, londonOnly } = useRestaurants();
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);

  // Filters — same pattern as the Leads search, tuned to what actually varies
  // on this page: freshness (new vs. opening soon), area, cuisine, and fit.
  const [search, setSearch] = useState("");
  const [areaSel, setAreaSel] = useState<string[]>([]);
  const [cuisineSel, setCuisineSel] = useState<string[]>([]);
  const [status, setStatus] = useState<OpeningFilter>("all");
  const [onlyRecommended, setOnlyRecommended] = useState(false);

  const allOpenings = useMemo(
    () =>
      restaurants
        .filter((r) => r.openingStatus === "new_this_week" || r.openingStatus === "opening_soon")
        .filter((r) => !r.excluded)
        .sort((a, b) => b.leadScore - a.leadScore),
    [restaurants]
  );

  const areaOptions = useMemo(
    () => londonOnly
      ? Array.from(new Set(allOpenings.filter((r) => isLondon(r.borough)).map((r) => r.borough))).sort()
      : Array.from(new Set(allOpenings.map((r) => getRegion(r.borough, r.postcode)))).sort(),
    [allOpenings, londonOnly]
  );
  const cuisineOptions = useMemo(
    () => Array.from(new Set(allOpenings.map((r) => r.cuisineType))).sort(),
    [allOpenings]
  );

  // Reset area selection when toggling London/UK (options change underneath it).
  useEffect(() => { setAreaSel([]); }, [londonOnly]);

  const openings = useMemo(() => {
    const areaLC = areaSel.map((a) => a.toLowerCase());
    const cuisineLC = cuisineSel.map((c) => c.toLowerCase());
    return allOpenings
      .filter((r) => (status === "all" ? true : r.openingStatus === status))
      .filter((r) => {
        if (!areaLC.length) return true;
        if (londonOnly) return areaLC.includes(r.borough.toLowerCase());
        return areaLC.includes(getRegion(r.borough, r.postcode).toLowerCase());
      })
      .filter((r) => (cuisineLC.length ? cuisineLC.includes(r.cuisineType.toLowerCase()) : true))
      .filter((r) => (onlyRecommended ? r.recommended : true))
      .filter((r) =>
        search
          ? `${r.name} ${r.borough} ${r.cuisineType} ${r.postcode}`
              .toLowerCase()
              .includes(search.toLowerCase())
          : true
      );
  }, [allOpenings, search, areaSel, cuisineSel, status, onlyRecommended, londonOnly]);

  async function scan() {
    setScanning(true);
    setScanMsg(null);
    try {
      // Full-UK mode scans the whole UK; London-only mode restricts to London.
      const res = await fetch("/api/scan-openings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: londonOnly ? "london" : "uk" }),
      });
      const data = await res.json();
      if (data.error) {
        setScanMsg(data.error === "no_api_key" ? "Add an API key to enable web scanning." : `Scan failed: ${data.message || data.error}`);
        return;
      }
      const found: ScannedOpening[] = data.openings || [];
      const { toAdd, toUpdate, total } = prepareOpenings(found, restaurants);
      if (toAdd.length) addRestaurants(toAdd);
      if (Object.keys(toUpdate).length) updateMany(toUpdate);
      setScanMsg(total > 0 ? `Found ${total} opening${total === 1 ? "" : "s"} from the web.` : "No new openings found right now.");
    } catch {
      setScanMsg("Scan failed — please try again.");
    } finally {
      setScanning(false);
    }
  }

  // Drop a venue from the New openings view (keeps the record; a later scan
  // won't re-flag it as new — see prepareOpenings).
  function removeAsNew(id: string) {
    updateRestaurant(id, { openingStatus: "open", dismissedAsNew: true });
  }

  // Bulk safety valve for stacking from any source (a scan, or a data-pipeline
  // gap like the 2026-07-06 geocode-drop bug that briefly mass-flagged ~11k
  // long-existing venues as new) — clears everything currently shown in one go.
  function clearAll() {
    const patches: Record<string, { openingStatus: "open"; dismissedAsNew: true }> = {};
    for (const r of openings) patches[r.id] = { openingStatus: "open", dismissedAsNew: true };
    updateMany(patches);
  }

  return (
    <div>
      <PageHeader
        title="New openings"
        subtitle={
          openings.length === allOpenings.length
            ? `${allOpenings.length} restaurant${allOpenings.length === 1 ? "" : "s"} newly opened or opening soon`
            : `${openings.length} of ${allOpenings.length} shown`
        }
        action={
          <div className="flex items-center gap-2">
            {openings.length > 0 && (
              <button
                onClick={clearAll}
                className="rounded-lg bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-200"
                title="Remove everything currently shown from New openings (keeps the records, just stops treating them as new)"
              >
                {openings.length === allOpenings.length ? "Clear all" : `Clear shown (${openings.length})`}
              </button>
            )}
            <button
              onClick={scan}
              disabled={scanning}
              className="flex items-center gap-2 rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-60"
            >
              <Globe size={16} />
              {scanning ? "Scanning the web…" : "Scan the web for new openings"}
            </button>
          </div>
        }
      />

      {scanMsg && (
        <div className="mb-4 rounded-xl bg-white px-4 py-2.5 text-sm text-slate-600 shadow-sm ring-1 ring-slate-200">{scanMsg}</div>
      )}

      {allOpenings.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, borough, postcode…"
            className="min-w-[220px] flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brand-500"
          />
          <MultiSelect label={londonOnly ? "Borough" : "Region"} options={areaOptions} selected={areaSel} onChange={setAreaSel} />
          <MultiSelect label="Cuisines" options={cuisineOptions} selected={cuisineSel} onChange={setCuisineSel} />
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as OpeningFilter)}
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
          >
            <option value="all">New &amp; opening soon</option>
            <option value="new_this_week">New this week</option>
            <option value="opening_soon">Opening soon</option>
          </select>
          <label className="flex items-center gap-1.5 text-sm text-slate-600">
            <input type="checkbox" checked={onlyRecommended} onChange={(e) => setOnlyRecommended(e.target.checked)} />
            Recommended
          </label>
        </div>
      )}

      <div className="space-y-3">
        {openings.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
            <div className="min-w-[220px] flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/restaurants/${r.id}`} className="font-semibold text-slate-900 hover:text-brand-600">{r.name}</Link>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.openingStatus === "new_this_week" ? "bg-purple-100 text-purple-700" : "bg-amber-100 text-amber-700"}`}>
                  {r.openingStatus === "new_this_week" ? "New this week" : "Opening soon"}
                </span>
                {r.recommended && <RecommendBadge />}
              </div>
              <p className="mt-1 text-sm text-slate-500">{r.cuisineType} · <PriceTag tier={r.priceTier} /> · {r.borough}</p>
              {r.openingEvidence && (
                <p className="mt-1 text-xs text-slate-400">
                  Evidence:{" "}
                  {r.openingSourceUrl ? (
                    <a href={r.openingSourceUrl} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">
                      {r.openingEvidence}
                    </a>
                  ) : (
                    r.openingEvidence
                  )}
                </p>
              )}
            </div>

            <div className="text-center">
              <p className="text-xs text-slate-400">Opening</p>
              <p className="text-sm font-medium text-slate-700">{r.expectedOpeningDate ?? "—"}</p>
            </div>

            <div className="text-center">
              <p className="text-2xl font-bold text-slate-900">{r.leadScore}</p>
              <LeadBadge category={r.leadCategory} />
            </div>

            <div className="flex flex-col items-end gap-2">
              <OutreachBadge status={r.outreachStatus} />
              <Link href="/emails" className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600">Review &amp; draft email</Link>
              <button
                onClick={() => removeAsNew(r.id)}
                className="text-xs font-medium text-slate-400 hover:text-slate-600"
                title="Keep the venue but remove it from New openings"
              >
                Remove as new
              </button>
            </div>
          </div>
        ))}
        {openings.length === 0 && allOpenings.length > 0 && (
          <div className="rounded-xl bg-white p-8 text-center text-slate-400 ring-1 ring-slate-200">
            <p>No openings match these filters.</p>
          </div>
        )}
        {allOpenings.length === 0 && (
          <div className="rounded-xl bg-white p-8 text-center text-slate-400 ring-1 ring-slate-200">
            <p>No new openings tracked yet.</p>
            <p className="mt-1 text-xs">Click &ldquo;Scan the web for new openings&rdquo; to find recently opened restaurants.</p>
          </div>
        )}
      </div>
    </div>
  );
}
