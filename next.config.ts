import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // dukascopy-node uses Node APIs; keep it out of the bundle.
  serverExternalPackages: ["dukascopy-node"],
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
