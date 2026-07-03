/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // The base FSA dataset is served from Supabase Storage in production (see
  // src/lib/base-dataset.ts + the weekly refresh workflow), so the serverless
  // routes no longer need the 36 MB file bundled into them.
  experimental: {
    // The customer sync reads the (tiny) seed customer list from disk to know
    // which venues are human-asserted customers — bundle it into that route.
    outputFileTracingIncludes: {
      "/api/sync-customers": ["./public/seed-customers.json"],
    },
  },
};

export default nextConfig;
