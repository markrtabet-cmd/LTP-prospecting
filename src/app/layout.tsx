import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ZoomLock } from "@/components/ZoomLock";

// Self-hosted at build time by next/font — no runtime request to Google.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "La Tua Pasta — Prospecting Tool",
  description: "UK restaurant prospecting and outreach tool for La Tua Pasta.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // Browsers that support it (Android Chrome) shrink the layout for the
  // keyboard natively; iOS is handled by the VisualViewport logic in Assistant.
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <ZoomLock />
        {children}
      </body>
    </html>
  );
}
