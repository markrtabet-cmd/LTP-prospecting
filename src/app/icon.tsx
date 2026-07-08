import { ImageResponse } from "next/og";

// Favicon — generated so it always matches the brand. Full-bleed La Tua Pasta
// green square with "LTP", so launcher/tab masks crop it cleanly.
export const size = { width: 192, height: 192 };
export const contentType = "image/png";

export default function Icon() {
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
          fontSize: 96,
          fontWeight: 800,
          letterSpacing: -4,
        }}
      >
        LTP
      </div>
    ),
    { ...size },
  );
}
