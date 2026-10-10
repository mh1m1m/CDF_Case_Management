import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Workspace packages ship TypeScript source.
  transpilePackages: [
    "@cdf/application",
    "@cdf/audit",
    "@cdf/authorization",
    "@cdf/config",
    "@cdf/contracts",
    "@cdf/domain",
    "@cdf/i18n",
    "@cdf/infrastructure",
    "@cdf/ui",
    "@cdf/validation",
    "@cdf/workflow",
  ],
  serverExternalPackages: ["postgres"],
  experimental: { serverActions: { bodySizeLimit: "64kb" } },
};

export default config;
