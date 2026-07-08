import { ImageResponse } from "next/og";

// PWA install icon (512, also used as the maskable icon) — brand-green LTP
// square, full-bleed so launcher masks crop cleanly.
export function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#739630",
          color: "#ffffff",
          fontSize: 248,
          fontWeight: 800,
          letterSpacing: -10,
        }}
      >
        LTP
      </div>
    ),
    { width: 512, height: 512 },
  );
}
