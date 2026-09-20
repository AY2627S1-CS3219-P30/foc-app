import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle so the Docker image carries only what
  // it needs to run, rather than the whole node_modules tree.
  output: "standalone",
};

export default nextConfig;
