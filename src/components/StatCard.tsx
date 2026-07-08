"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  accent?: "default" | "green" | "amber" | "blue" | "purple";
  /** Entrance-stagger delay in ms (visual only). */
  delay?: number;
  /** When set, the whole card becomes a link to this route. */
  href?: string;
}

const accents: Record<NonNullable<StatCardProps["accent"]>, string> = {
  default: "text-slate-900",
  green: "text-green-600",
  amber: "text-amber-600",
  blue: "text-blue-600",
  purple: "text-purple-600",
};

/** Count up to the target over ~800ms (ease-out); renders instantly for
 * reduced-motion users and for non-numeric values like "…". */
function useCountUp(raw: string | number): string {
  const target = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, ""));
  const formatted = typeof raw === "number" ? raw.toLocaleString() : raw;
  const animatable =
    Number.isFinite(target) &&
    typeof window !== "undefined" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const [display, setDisplay] = useState<string>(animatable ? "0" : String(formatted));
  const rafRef = useRef<number>();

  useEffect(() => {
    if (!animatable) {
      setDisplay(String(formatted));
      return;
    }
    const start = performance.now();
    const duration = 800;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(target * eased).toLocaleString());
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, animatable]);

  return Number.isFinite(target) ? display : String(formatted);
}

export function StatCard({ label, value, sub, accent = "default", delay = 0, href }: StatCardProps) {
  const display = useCountUp(value);
  const body = (
    <div
      className={`anim-rise h-full rounded-xl bg-white p-5 shadow-sm transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-md ${href ? "cursor-pointer hover:ring-1 hover:ring-slate-200" : ""}`}
      style={{ "--rise-delay": `${delay}ms` } as React.CSSProperties}
    >
      <p className="text-[13px] font-medium text-slate-500">{label}</p>
      <p
        className={`mt-1.5 text-[28px] font-semibold leading-none tracking-[-0.02em] [font-variant-numeric:tabular-nums] ${accents[accent]}`}
      >
        {display}
      </p>
      {sub && <p className="mt-1.5 text-xs text-slate-400">{sub}</p>}
    </div>
  );
  return href ? (
    <Link href={href} className="block h-full">
      {body}
    </Link>
  ) : (
    body
  );
}
