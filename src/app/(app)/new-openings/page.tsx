"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Globe } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { LeadBadge, OutreachBadge, PriceTag, RecommendBadge } from "@/components/StatusBadge";
import { prepareOpenings, type ScannedOpening } from "@/lib/openings";
import { useRestaurants } from "@/lib/store";

export default function NewOpeningsPage() {
  const { restaurants, addRestaurants, updateMany } = useRestaurants();
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);

  const openings = useMemo(
    () =>
      restaurants
        .filter((r) => r.openingStatus === "new_this_week" || r.openingStatus === "opening_soon")
        .sort((a, b) => b.leadScore - a.leadScore),
    [restaurants]
  );

  async function scan() {
    setScanning(true);
    setScanMsg(null);
    try {
      const res = await fetch("/api/scan-openings", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
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

  return (
    <div>
      <PageHeader
        title="New openings"
        subtitle={`${openings.length} restaurants newly opened or opening soon`}
        action={
          <button
            onClick={scan}
            disabled={scanning}
            className="flex items-center gap-2 rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-60"
          >
            <Globe size={16} />
            {scanning ? "Scanning the web…" : "Scan the web for new openings"}
          </button>
        }
      />

      {scanMsg && (
        <div className="mb-4 rounded-xl bg-white px-4 py-2.5 text-sm text-slate-600 shadow-sm ring-1 ring-slate-200">{scanMsg}</div>
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
              {r.openingEvidence && <p className="mt-1 text-xs text-slate-400">Evidence: {r.openingEvidence}</p>}
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
            </div>
          </div>
        ))}
        {openings.length === 0 && (
          <div className="rounded-xl bg-white p-8 text-center text-slate-400 ring-1 ring-slate-200">
            <p>No new openings tracked yet.</p>
            <p className="mt-1 text-xs">Click “Scan the web for new openings” to find recently opened London restaurants.</p>
          </div>
        )}
      </div>
    </div>
  );
}
