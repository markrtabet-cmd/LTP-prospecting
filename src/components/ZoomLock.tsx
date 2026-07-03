"use client";

import { useEffect } from "react";

// iOS Safari ignores maximum-scale/user-scalable for pinch gestures and
// implements page zoom through its proprietary gesture events instead.
// Cancelling those keeps the page locked at 1x. The Leaflet map is
// unaffected: its pinch-zoom is driven by touch events, not browser zoom.
export function ZoomLock() {
  useEffect(() => {
    if (navigator.maxTouchPoints < 2) return;
    const prevent = (e: Event) => e.preventDefault();
    const events = ["gesturestart", "gesturechange", "gestureend"];
    for (const ev of events) document.addEventListener(ev, prevent);
    return () => {
      for (const ev of events) document.removeEventListener(ev, prevent);
    };
  }, []);
  return null;
}
