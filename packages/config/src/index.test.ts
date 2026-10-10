import { describe, expect, it } from "vitest";
import {
  assertNoSecretsInPublicEnv,
  isLocalOnlyEnvironment,
  loadInvestigationServerEnv,
  loadPortalServerEnv,
} from "./index";

describe("assertNoSecretsInPublicEnv", () => {
  it("rejects credential-like NEXT_PUBLIC_ variables", () => {
    expect(() => assertNoSecretsInPublicEnv({ NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: "x" })).toThrow(
      /NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY/,
    );
    expect(() => assertNoSecretsInPublicEnv({ NEXT_PUBLIC_DATABASE_URL: "x" })).toThrow();
  });
  it("allows non-credential public variables", () => {
    expect(() => assertNoSecretsInPublicEnv({ NEXT_PUBLIC_CDF_ENVIRONMENT_LABEL: "DEV" })).not.toThrow();
  });
});

describe("server env loading", () => {
  it("does not echo secret values in errors", () => {
    try {
      loadPortalServerEnv({
        CDF_ENVIRONMENT: "local",
        CDF_PORTAL_DATABASE_URL: "postgres://u:p@localhost:5432/db",
        CDF_REPORT_SECRET_PEPPER: "too-short-secret-value",
        CDF_RATE_LIMIT_SALT: "x".repeat(40),
      });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).toContain("CDF_REPORT_SECRET_PEPPER");
      expect(String(e)).not.toContain("too-short-secret-value");
    }
  });
  it("requires dev identity secrets when the local-dev provider is selected", () => {
    expect(() =>
      loadInvestigationServerEnv({
        CDF_ENVIRONMENT: "local",
        CDF_BFF_DATABASE_URL: "postgres://u:p@localhost:5432/db",
        CDF_IDENTITY_PROVIDER: "local-dev",
      }),
    ).toThrow(/CDF_DEV_IDENTITY_SECRET/);
  });
});

describe("isLocalOnlyEnvironment", () => {
  it("is false on Vercel even when CDF_ENVIRONMENT says local", () => {
    expect(isLocalOnlyEnvironment({ VERCEL: "1", CDF_ENVIRONMENT: "local" })).toBe(false);
  });
  it("is false for hosted dev/demo", () => {
    expect(isLocalOnlyEnvironment({ CDF_ENVIRONMENT: "demo" })).toBe(false);
  });
  it("is true for local and test", () => {
    expect(isLocalOnlyEnvironment({ CDF_ENVIRONMENT: "local" })).toBe(true);
    expect(isLocalOnlyEnvironment({ CDF_ENVIRONMENT: "test" })).toBe(true);
  });
});
