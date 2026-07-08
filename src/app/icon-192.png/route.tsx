import { ImageResponse } from "next/og";

// PWA install icon (192) — generated brand-green LTP square, referenced by the
// web manifest. Kept as a route so it can never drift from the brand colour.
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
          background: "#556b2f",
          color: "#ffffff",
          fontSize: 92,
          fontWeight: 800,
          letterSpacing: -4,
        }}
      >
        LTP
      </div>
    ),
    { width: 192, height: 192 },
  );
}
