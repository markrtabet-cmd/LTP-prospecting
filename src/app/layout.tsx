import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ZoomLock } from "@/components/ZoomLock";

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
    <html lang="en">
      <body>
        <ZoomLock />
        {children}
      </body>
    </html>
  );
}
