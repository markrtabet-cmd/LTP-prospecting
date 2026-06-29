import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#fef3f2",
          100: "#fee4e2",
          500: "#b91c1c",
          600: "#991b1b",
          700: "#7f1d1d",
        },
      },
    },
  },
  plugins: [],
};

export default config;
