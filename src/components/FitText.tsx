"use client";

import { useLayoutEffect, useRef } from "react";

// Keeps a single line of text on ONE line by shrinking its font only when it
// would otherwise overflow — used for long restaurant / cuisine / area names in
// the tables. The wrapper is inline-block with a max width, so a long value
// caps the column (instead of wrapping or blowing it out) and the text scales
// down to fit; short values stay at full size.
export function FitText({
  children,
  maxWidth,
  base = 14,
  min = 10,
  className,
  title,
}: {
  children: React.ReactNode;
  /** Cap in px — the column never grows past this; text shrinks to fit it. */
  maxWidth: number;
  /** Starting font size in px (matches the surrounding text-sm = 14). */
  base?: number;
  /** Smallest font size we'll shrink to. */
  min?: number;
  className?: string;
  title?: string;
}) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const inner = innerRef.current;
    if (!wrap || !inner) return;
    const fit = () => {
      inner.style.fontSize = `${base}px`;
      const avail = wrap.clientWidth;
      const natural = inner.scrollWidth;
      if (avail > 0 && natural > avail) {
        inner.style.fontSize = `${Math.max(min, Math.floor((base * avail) / natural))}px`;
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [children, maxWidth, base, min]);

  return (
    <span
      ref={wrapRef}
      title={title}
      className={className}
      style={{ display: "inline-block", maxWidth, overflow: "hidden", whiteSpace: "nowrap", verticalAlign: "bottom" }}
    >
      <span ref={innerRef} style={{ display: "inline-block", whiteSpace: "nowrap" }}>
        {children}
      </span>
    </span>
  );
}
