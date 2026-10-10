// MockMalwareScanner: a deterministic stand-in for a malware scanning service (ADR-006, threat T10).
// It flags the industry-standard EICAR test signature and nothing else, so the quarantine → reject path
// can be exercised end to end without real malware.
// PRODUCTION_SUBSTITUTION_REQUIRED: production routes quarantined objects to the CDF-approved scanner.
import type { MalwareScanner, ScanResult } from "@cdf/application";

// Assembled at runtime so the literal signature never sits in the repository (desktop AV would quarantine it).
const EICAR_PARTS = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"];
export const EICAR_TEST_SIGNATURE = EICAR_PARTS.join("");

export class MockMalwareScanner implements MalwareScanner {
  readonly name = "mock-scanner (PRODUCTION_SUBSTITUTION_REQUIRED)";

  async scan(content: Uint8Array, _hint: { contentType: string; objectKey: string }): Promise<ScanResult> {
    // Only the first 1 KiB is inspected; the signature is defined to appear at the start of a test file.
    const head = new TextDecoder("latin1").decode(content.subarray(0, 1024));
    return { status: head.includes(EICAR_TEST_SIGNATURE) ? "INFECTED" : "CLEAN", scanner: this.name };
  }
}
