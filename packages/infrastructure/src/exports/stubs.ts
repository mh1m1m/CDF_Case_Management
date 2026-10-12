// Prototype export adapters (ADR-026). None of them is a production control.
// PRODUCTION_SUBSTITUTION_REQUIRED:
//   StubJsonExportRenderer  → CDF document rendering (PDF/XLSX with classification banners and page marking)
//   InMemoryExportStore     → a private Alibaba OSS export bucket, KMS-encrypted, write-once
//   StubExportMailer        → the CDF mail relay with an approved external-domain list
import type { ExportMailer, ExportRenderer, ExportStore, RenderedExport } from "@cdf/application";
import type { ExportDocument } from "@cdf/contracts";

/** Exports keys produced by api.generate_export only; anything else is refused (no path traversal). */
export const EXPORT_KEY_PATTERN = /^exports\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** Canonical JSON of the document: honest about what it is, whatever format was requested. */
export class StubJsonExportRenderer implements ExportRenderer {
  readonly kind = "stub-json" as const;

  async render(document: ExportDocument): Promise<RenderedExport> {
    const body = new TextEncoder().encode(JSON.stringify(document, null, 2));
    return { body, contentType: "application/json", fileName: `export-${document.requestId}.json` };
  }
}

/** Write-once in-memory store. Files are lost on restart; nothing is ever written to disk. */
export class InMemoryExportStore implements ExportStore {
  readonly kind = "memory" as const;
  private readonly files = new Map<string, RenderedExport>();

  async put(storageKey: string, file: RenderedExport): Promise<void> {
    if (!EXPORT_KEY_PATTERN.test(storageKey)) throw new Error("Invalid export storage key");
    if (this.files.has(storageKey)) throw new Error("Export storage key already used");
    this.files.set(storageKey, file);
  }

  has(storageKey: string): boolean {
    return this.files.has(storageKey);
  }
}

/** Sends nothing. Accepts synthetic @example.test addresses only and remembers the last deliveries for tests. */
export class StubExportMailer implements ExportMailer {
  readonly kind = "stub-email" as const;
  readonly delivered: { to: string[]; fileName: string }[] = [];

  async send(to: readonly string[], file: RenderedExport): Promise<boolean> {
    if (to.length === 0 || !to.every((a) => /^[a-z0-9._%+-]{1,64}@example\.test$/.test(a))) return false;
    this.delivered.push({ to: [...to], fileName: file.fileName });
    if (this.delivered.length > 100) this.delivered.shift();
    return true;
  }
}
