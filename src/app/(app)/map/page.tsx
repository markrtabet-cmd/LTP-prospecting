"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { CalendarDays } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";

// Leaflet touches `window`, so the map must be client-only (no SSR).
const MapView = dynamic(() => import("@/components/MapView"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-slate-400">Loading map…</div>
  ),
});

export default function MapPage() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Map"
        subtitle="Geographic view of all prospects, new openings and customers"
        action={
          <Link
            href="/calendar"
            className="flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600"
          >
            <CalendarDays className="h-4 w-4" /> My calendar
          </Link>
        }
      />
      <div className="min-h-0 flex-1">
        <MapView />
      </div>
    </div>
  );
}
