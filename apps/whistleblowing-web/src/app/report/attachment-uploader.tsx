"use client";
// Reporter attachments (Drive field 19; CDF-72, ADR-015). Uploads one file per request to the portal's
// own server, with the Report ID and secret held only in memory. File names stay in this browser.
import { useRef, useState } from "react";
import { ALLOWED_CONTENT_TYPES } from "@cdf/domain";
import { createTranslator, type Locale, type MessageKey } from "@cdf/i18n";
import { CDFAlert, CDFCard, buttonClass } from "@cdf/ui";

const ACCEPT = ALLOWED_CONTENT_TYPES.flatMap((t) => t.extensions.map((e) => `.${e}`)).join(",");

interface UploadOutcome {
  file: string;
  ok: boolean;
  text: string;
}

export function AttachmentUploader({
  locale,
  reportRef,
  secret,
  source,
}: {
  locale: Locale;
  reportRef: string;
  secret: string;
  source: "REPORT" | "FOLLOW_UP";
}) {
  const t = createTranslator(locale);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<UploadOutcome[]>([]);
  const [error, setError] = useState<string | null>(null);

  const describe = (
    body: { ok: boolean; displayName?: string; code?: string; reason?: string },
    file: string,
  ) => {
    if (body.ok && body.displayName)
      return t("portal.attachments.received", { file, name: body.displayName });
    const reason =
      body.code === "INVALID_FILE" && body.reason
        ? t(`portal.attachments.reason.${body.reason}` as MessageKey)
        : t(`portal.attachments.code.${body.code ?? "UNAVAILABLE"}` as MessageKey);
    return t("portal.attachments.failed", { file, reason });
  };

  const upload = async () => {
    const files = Array.from(input.current?.files ?? []);
    if (files.length === 0) {
      setError(t("portal.attachments.noFiles"));
      input.current?.focus();
      return;
    }
    setError(null);
    setBusy(true);
    const results: UploadOutcome[] = [];
    for (const file of files) {
      const data = new FormData();
      data.set("reportRef", reportRef);
      data.set("secret", secret);
      data.set("source", source);
      data.set("file", file);
      let body: { ok: boolean; displayName?: string; code?: string; reason?: string };
      try {
        const response = await fetch("/report/attachments", {
          method: "POST",
          body: data,
          cache: "no-store",
        });
        body = await response.json();
      } catch {
        body = { ok: false, code: "UNAVAILABLE" };
      }
      results.push({ file: file.name, ok: body.ok, text: describe(body, file.name) });
      setOutcomes([...results]);
    }
    if (input.current) input.current.value = "";
    setBusy(false);
  };

  return (
    <CDFCard title={t("portal.attachments.title")} testId="attachment-uploader">
      <p className="mb-3">{t("portal.attachments.intro")}</p>
      <div className="mb-3">
        <label htmlFor="attachments" className="mb-1 block font-semibold">
          {t("portal.attachments.label")}
        </label>
        <p id="attachments-hint" className="mb-1 text-sm text-cdf-text-secondary">
          {t("portal.attachments.hint")}
        </p>
        <p id="attachments-warning" className="mb-2 text-sm text-cdf-text-secondary">
          {t("portal.attachments.metadataWarning")}
        </p>
        <input
          ref={input}
          id="attachments"
          type="file"
          multiple
          accept={ACCEPT}
          aria-describedby={`attachments-hint attachments-warning${error ? " attachments-error" : ""}`}
          aria-invalid={error ? true : undefined}
          data-testid="attachment-input"
          disabled={busy}
        />
        {error ? (
          <p id="attachments-error" className="mt-1 text-sm text-cdf-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        className={buttonClass("secondary")}
        onClick={upload}
        disabled={busy}
        data-testid="upload-attachments"
      >
        {busy ? t("portal.attachments.uploading") : t("portal.attachments.upload")}
      </button>
      <div aria-live="polite" className="mt-3">
        {outcomes.length > 0 ? (
          <>
            <h3 className="font-semibold">{t("portal.attachments.resultsTitle")}</h3>
            <ul data-testid="attachment-results" className="mt-1 space-y-1">
              {outcomes.map((o, i) => (
                <li key={i} data-testid="attachment-result" data-ok={o.ok ? "true" : "false"}>
                  {o.text}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </CDFCard>
  );
}

/** Shown instead of the uploader where this deployment has no storage for reporter attachments. */
export function AttachmentsUnavailable({ locale }: { locale: Locale }) {
  const t = createTranslator(locale);
  return (
    <CDFAlert tone="info" testId="attachments-unavailable">
      {t("portal.attachments.unavailable")}
    </CDFAlert>
  );
}
