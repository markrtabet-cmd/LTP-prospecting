import type { MetadataRoute } from "next";

// Web app manifest — makes the site installable ("Add to Home Screen") as a
// standalone app on iOS/Android/desktop. Icons are the sidebar LTP logo,
// full-bleed so launcher masks (circles, squircles) crop it cleanly. No
// service worker on purpose: the app must always serve live Power BI + shared
// DB state, and a caching worker risks exactly the stale-data incidents we
// guard against elsewhere.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "La Tua Pasta — Prospecting",
    short_name: "LTP",
    description: "UK restaurant prospecting and outreach tool for La Tua Pasta.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
