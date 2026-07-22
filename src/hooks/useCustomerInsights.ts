"use client";

import { useEffect, useState } from "react";
import type { Restaurant } from "@/lib/types";
import type { CustomerInsights } from "@/app/api/powerbi/customer-insights/route";

// Live per-customer Power BI data (account facts, sales, contacts), fetched fresh
// from /api/powerbi/customer-insights whenever the identifying fields change. The
// route is force-dynamic (never cached), so lifting the fetch into this hook lets
// the desktop profile share ONE request across the Sales/Account card, the
// Contact card, and the customer-service outreach — instead of each self-fetching.
// Pass null (e.g. for a prospect) to stay idle and skip the request entirely.

export type InsightsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "unlinked" }
  | { status: "error"; message?: string }
  | { status: "ready"; data: CustomerInsights };

// Pass restricted=true when the viewer is a rep looking at a customer that
// isn't theirs — the request then asks the server for the contact-only payload
// (no sales / commercial figures), so that data never reaches the browser.
export function useCustomerInsights(r: Restaurant | null, restricted = false): InsightsState {
  const [state, setState] = useState<InsightsState>({ status: "idle" });

  const id = r?.id;
  const code = r?.customerAccountCode;
  const name = r?.name;
  const postcode = r?.postcode;

  useEffect(() => {
    if (!r) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    const qs = new URLSearchParams();
    if (code) qs.set("code", code);
    if (name) qs.set("name", name);
    if (postcode) qs.set("postcode", postcode);
    if (restricted) qs.set("contactOnly", "1");
    setState({ status: "loading" });
    fetch(`/api/powerbi/customer-insights?${qs.toString()}`)
      .then((res) => res.json())
      .then((d: CustomerInsights) => {
        if (cancelled) return;
        if (d.error) setState({ status: "error", message: d.error });
        else if (!d.configured || !d.found) setState({ status: "unlinked" });
        else setState({ status: "ready", data: d });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", message: "Network error" });
      });
    return () => {
      cancelled = true;
    };
    // r is only used for the null-check above; the identifying fields are the deps.
  }, [id, code, name, postcode, restricted]); // eslint-disable-line react-hooks/exhaustive-deps

  return state;
}
