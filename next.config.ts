import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: "/inquiry",
        destination: "/contact",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
