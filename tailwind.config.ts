import type { Config } from "tailwindcss";

// Theme is driven by the design tokens in src/app/globals.css (:root vars) —
// edit values there, not here. Existing utility class names keep their ROLE:
//   brand-500 = primary action, brand-600 = hover, brand-700 = pressed/dark,
// so components written against the palette pick up the La Tua Pasta green
// (#556b2f) without edits. slate-* is remapped to warm neutrals for the same reason.
const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "var(--brand-50)",
          100: "var(--brand-100)",
          200: "var(--brand-200)",
          300: "var(--brand-200)",
          400: "var(--brand-400)",
          500: "var(--brand-600)", // primary
          600: "var(--brand-700)", // hover
          700: "var(--brand-800)", // pressed / dark accents
          800: "var(--brand-800)",
          900: "var(--brand-900)",
        },
        // Warm neutrals in place of Tailwind's cool slate.
        slate: {
          50: "#f7f4f3",
          100: "#f1edea",
          200: "#efeae8", // --border-hairline
          300: "#d9d2ce",
          400: "#9a928e", // --text-muted
          500: "#6b6360", // --text-secondary
          600: "#57504d",
          700: "#453f3d",
          800: "#332e2c",
          900: "#211d1c", // --text-primary
        },
        // Harmonised success green (softly desaturated, sits well with red).
        green: {
          50: "#ecfdf3",
          100: "#dcfae6",
          200: "#a9efc5",
          400: "#47cd89",
          500: "#17b26a",
          600: "#079455",
          700: "#067647",
          800: "#085d3a",
        },
        purple: {
          600: "#7c3aed",
        },
      },
      borderRadius: {
        DEFAULT: "var(--radius-sm)", // 8px — no sharp corners anywhere
        md: "10px",
        lg: "var(--radius-md)", // 12px — buttons, pills, nav items
        xl: "var(--radius-lg)", // 16px — cards
        "2xl": "20px", // sheets / modals
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        DEFAULT: "var(--shadow-md)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        xl: "var(--shadow-lg)",
      },
      fontFamily: {
        sans: [
          "var(--font-inter)",
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
      },
      transitionTimingFunction: {
        "out-soft": "cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },
  plugins: [],
};

export default config;
