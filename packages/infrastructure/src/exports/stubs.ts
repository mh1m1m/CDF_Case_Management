// Prototype export adapters (ADR-026). None of them is a production control.
// PRODUCTION_SUBSTITUTION_REQUIRED:
//   StubJsonExportRenderer  → CDF document rendering (PDF/XLSX with classification banners and page marking)
//   InMemoryExportStore     → a private Alibaba OSS export bucket, KMS-encrypted, write-once
//   StubExportMailer        → the CDF mail relay with an approved external-domain list, and the corporate directory
//                             lookup of internal recipients' addresses
import type { ExportMailer, ExportRenderer, ExportStore, RenderedExport } from "@cdf/application";
import type { ExportDelivery, ExportDocument } from "@cdf/contracts";

/** Exports keys produced by api.generate_export only; anything else is refused (no path traversal). */
export const EXPORT_KEY_PATTERN = /^exports\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export interface StubJsonExportRendererOptions {
  /**
   * DEC-51 (P12-6b-1, F10): the generation date as a formal record shows it, Gregorian and Hijri, in each locale. The
   * app passes its formatter, so this adapter carries no locale rules of its own.
   */
  recordDate?: (locale: "en" | "ar", at: Date) => string;
  /** The clock; tests pass a fixed one. */
  now?: () => Date;
}

/**
 * Canonical JSON of the document: honest about what it is, whatever format was requested. With a `recordDate`, the
 * file also says when it was generated: the instant (`generatedAt`) and the record date in English and Arabic
 * (`generatedOn`). Presentation only: the database's hash binds the document, not the file.
 */
export class StubJsonExportRenderer implements ExportRenderer {
  readonly kind = "stub-json" as const;

  constructor(private readonly options: StubJsonExportRendererOptions = {}) {}

  async render(document: ExportDocument): Promise<RenderedExport> {
    const { recordDate, now = () => new Date() } = this.options;
    let content: object = document;
    if (recordDate) {
      const at = now();
      content = {
        ...document,
        generatedAt: at.toISOString(),
        generatedOn: { en: recordDate("en", at), ar: recordDate("ar", at) },
      };
    }
    const body = new TextEncoder().encode(JSON.stringify(content, null, 2));
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

const SYNTHETIC_ADDRESS = /^[a-z0-9._%+-]{1,64}@example\.test$/;
const USER_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/**
 * Sends nothing and looks up no address: internal recipients stay user ids, external ones must be synthetic
 * @example.test addresses. Remembers the last deliveries for tests.
 */
export class StubExportMailer implements ExportMailer {
  readonly kind = "stub-email" as const;
  readonly delivered: { to: ExportDelivery[]; fileName: string }[] = [];

  async send(to: readonly ExportDelivery[], file: RenderedExport): Promise<boolean> {
    const valid = (d: ExportDelivery) =>
      d.kind === "INTERNAL" ? USER_ID.test(d.userId) : SYNTHETIC_ADDRESS.test(d.email);
    if (to.length === 0 || !to.every(valid)) return false;
    this.delivered.push({ to: [...to], fileName: file.fileName });
    if (this.delivered.length > 100) this.delivered.shift();
    return true;
  }
}
