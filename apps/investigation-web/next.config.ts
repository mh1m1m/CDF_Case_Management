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
  // Evidence uploads are server actions (origin-checked by Next); the per-file limit (25 MiB) is enforced by
  // the domain rules and the database. Rate limiting of uploads is a gateway concern (PRODUCTION_SUBSTITUTION_REQUIRED).
  experimental: { serverActions: { bodySizeLimit: "26mb" } },
};

export default config;
