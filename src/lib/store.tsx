"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { hydrateVenue, type RawVenue } from "./mock-data";
import type { Restaurant } from "./types";

// Client-side data store.
//
// Base data = the real FSA dataset in public/london-restaurants.json (~20k
// venues), same for everyone. Manually-added venues + per-venue edits are the
// SHARED team state: persisted to Supabase via /api/data when configured, so
// everyone with the password sees the same pipeline. If Supabase isn't set up,
// it falls back to per-browser localStorage so the app still runs.

const STORAGE_KEY = "ltp_added_restaurants_v2";

export interface ViewFilter {
  cuisines?: string[];
  boroughs?: string[];
  text?: string;
  recommendedOnly?: boolean;
  existingCustomerOnly?: boolean;
  includeExcluded?: boolean;
}

interface StoreValue {
  restaurants: Restaurant[];
  loading: boolean;
  shared: boolean; // true when backed by the shared Supabase database
  addRestaurant: (r: Restaurant) => void;
  addRestaurants: (list: Restaurant[]) => void;
  updateRestaurant: (id: string, patch: Partial<Restaurant>) => void;
  updateMany: (patches: Record<string, Partial<Restaurant>>) => void;
  removeRestaurant: (id: string) => void;
  focusIds: string[] | null;
  setFocusIds: (ids: string[] | null) => void;
  viewFilter: ViewFilter | null;
  setViewFilter: (f: ViewFilter | null) => void;
}

const RestaurantsContext = createContext<StoreValue | null>(null);

export function RestaurantsProvider({ children }: { children: React.ReactNode }) {
  const [base, setBase] = useState<Restaurant[]>([]);
  const [baseDone, setBaseDone] = useState(false);
  const [added, setAdded] = useState<Restaurant[]>([]);
  const [overrides, setOverrides] = useState<Record<string, Partial<Restaurant>>>({});
  const [configured, setConfigured] = useState<boolean | null>(null); // null until /api/data answers
  const [dataDone, setDataDone] = useState(false);
  const [focusIds, setFocusIds] = useState<string[] | null>(null);
  const [viewFilter, setViewFilter] = useState<ViewFilter | null>(null);

  // Fetch + hydrate the real base dataset once.
  useEffect(() => {
    let cancelled = false;
    fetch("/london-restaurants.json")
      .then((r) => r.json())
      .then((data: { venues: RawVenue[] }) => {
        if (!cancelled) setBase(data.venues.map(hydrateVenue));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setBaseDone(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load shared team state (Supabase) or fall back to localStorage.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/data")
      .then((r) => r.json())
      .then((d: { configured?: boolean; added?: Restaurant[]; overrides?: Record<string, Partial<Restaurant>> }) => {
        if (cancelled) return;
        if (d && d.configured) {
          setConfigured(true);
          setAdded(d.added ?? []);
          setOverrides(d.overrides ?? {});
        } else {
          setConfigured(false);
          loadLocal();
        }
      })
      .catch(() => {
        if (!cancelled) {
          setConfigured(false);
          loadLocal();
        }
      })
      .finally(() => {
        if (!cancelled) setDataDone(true);
      });
    return () => {
      cancelled = true;
    };
    function loadLocal() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const p = JSON.parse(raw) as { added?: Restaurant[]; overrides?: Record<string, Partial<Restaurant>> };
          setAdded(p.added ?? []);
          setOverrides(p.overrides ?? {});
        }
      } catch {
        /* ignore */
      }
    }
  }, []);

  // Persist to localStorage ONLY in fallback mode (debounced + guarded).
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (configured !== false) return;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ added, overrides }));
      } catch (e) {
        console.warn("LTP: could not persist to localStorage (quota?).", e);
      }
    }, 250);
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, [added, overrides, configured]);

  // Keep shared state fresh: refetch when the tab regains focus.
  useEffect(() => {
    if (configured !== true) return;
    const onFocus = () => {
      fetch("/api/data")
        .then((r) => r.json())
        .then((d) => {
          if (d?.configured) {
            setAdded(d.added ?? []);
            setOverrides(d.overrides ?? {});
          }
        })
        .catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [configured]);

  // Fire a write to the shared DB (no-op in fallback mode).
  const serverPost = useCallback(
    (bodyObj: Record<string, unknown>) => {
      if (configured !== true) return;
      fetch("/api/data", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bodyObj),
      }).catch((e) => console.warn("LTP: shared save failed", e));
    },
    [configured]
  );

  const addRestaurant = useCallback(
    (r: Restaurant) => {
      setAdded((prev) => [r, ...prev.filter((p) => p.id !== r.id)]);
      serverPost({ op: "addMany", items: [r] });
    },
    [serverPost]
  );

  const addRestaurants = useCallback(
    (list: Restaurant[]) => {
      if (!list.length) return;
      setAdded((prev) => {
        const seen = new Set<string>();
        const incoming = list.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
        return [...incoming, ...prev.filter((p) => !seen.has(p.id))];
      });
      serverPost({ op: "addMany", items: list });
    },
    [serverPost]
  );

  const updateRestaurant = useCallback(
    (id: string, patch: Partial<Restaurant>) => {
      setOverrides((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
      setAdded((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
      serverPost({ op: "updateMany", patches: { [id]: patch } });
    },
    [serverPost]
  );

  const updateMany = useCallback(
    (patches: Record<string, Partial<Restaurant>>) => {
      const ids = Object.keys(patches);
      if (!ids.length) return;
      setOverrides((prev) => {
        const next = { ...prev };
        for (const id of ids) next[id] = { ...next[id], ...patches[id] };
        return next;
      });
      setAdded((prev) => prev.map((r) => (patches[r.id] ? { ...r, ...patches[r.id] } : r)));
      serverPost({ op: "updateMany", patches });
    },
    [serverPost]
  );

  const removeRestaurant = useCallback(
    (id: string) => {
      setAdded((prev) => prev.filter((r) => r.id !== id));
      setOverrides((prev) => {
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      serverPost({ op: "remove", id });
    },
    [serverPost]
  );

  // Merge DEDUPED BY ID: added wins over base; overrides applied to the winner.
  const restaurants = useMemo<Restaurant[]>(() => {
    const byId = new Map<string, Restaurant>();
    for (const r of added) {
      if (byId.has(r.id)) continue;
      byId.set(r.id, overrides[r.id] ? { ...r, ...overrides[r.id] } : r);
    }
    for (const r of base) {
      if (byId.has(r.id)) continue;
      byId.set(r.id, overrides[r.id] ? { ...r, ...overrides[r.id] } : r);
    }
    return Array.from(byId.values());
  }, [added, base, overrides]);

  const loading = !baseDone || !dataDone;

  const value = useMemo(
    () => ({
      restaurants,
      loading,
      shared: configured === true,
      addRestaurant,
      addRestaurants,
      updateRestaurant,
      updateMany,
      removeRestaurant,
      focusIds,
      setFocusIds,
      viewFilter,
      setViewFilter,
    }),
    [restaurants, loading, configured, addRestaurant, addRestaurants, updateRestaurant, updateMany, removeRestaurant, focusIds, viewFilter]
  );

  return <RestaurantsContext.Provider value={value}>{children}</RestaurantsContext.Provider>;
}

export function useRestaurants(): StoreValue {
  const ctx = useContext(RestaurantsContext);
  if (!ctx) throw new Error("useRestaurants must be used within RestaurantsProvider");
  return ctx;
}
