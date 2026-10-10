import "server-only";
import { loadInvestigationServerEnv } from "@cdf/config";

let cached: ReturnType<typeof loadInvestigationServerEnv> | undefined;
export function env() {
  cached ??= loadInvestigationServerEnv();
  return cached;
}
