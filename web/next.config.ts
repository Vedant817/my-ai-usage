import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
      },
      {
        source: "/manifest.webmanifest",
        headers: [{ key: "Content-Type", value: "application/manifest+json" }],
      },
    ];
  },
  async rewrites() {
    // Keep the collector contract (POST /v1/ingest, GET /v1/summary, ...) working
    // on the apex domain: API_URL=https://<app>.vercel.app with no path suffix.
    return [
      { source: "/v1/:path*", destination: "/api/v1/:path*" },
      { source: "/health", destination: "/api/health" },
    ];
  },
};

export default nextConfig;
