// KeyManagementProvider using in-process HMAC keys from server-only environment variables.
// PRODUCTION_SUBSTITUTION_REQUIRED: Alibaba Cloud KMS (HSM-backed) performs these operations in production;
// keys never enter application memory there.
import { createHmac } from "node:crypto";
import type { KeyManagementProvider } from "@cdf/application";

export class PrototypeKeyProvider implements KeyManagementProvider {
  constructor(
    private readonly reportSecretPepper: string,
    private readonly rateLimitSalt: string,
  ) {
    if (reportSecretPepper.length < 32 || rateLimitSalt.length < 32) {
      throw new Error("PrototypeKeyProvider requires 32+ character keys");
    }
  }

  async reportSecretHmac(secret: string): Promise<string> {
    return createHmac("sha256", this.reportSecretPepper).update(secret, "utf8").digest("hex");
  }

  async rateLimitKey(value: string): Promise<string> {
    return createHmac("sha256", this.rateLimitSalt).update(value, "utf8").digest("base64url").slice(0, 43);
  }
}
