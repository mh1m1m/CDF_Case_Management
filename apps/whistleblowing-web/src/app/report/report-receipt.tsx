"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createTranslator, type Locale } from "@cdf/i18n";
import { CDFAlert, CDFCard, buttonClass } from "@cdf/ui";
import { AttachmentUploader } from "./attachment-uploader";

/** Shows the Report ID and secret exactly once. Nothing is written to storage or the URL. */
export function ReportReceipt({
  locale,
  reportRef,
  secret,
  attachmentsEnabled,
}: {
  locale: Locale;
  reportRef: string;
  secret: string;
  attachmentsEnabled: boolean;
}) {
  const t = createTranslator(locale);
  const heading = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => heading.current?.focus(), []);

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setCopied(null);
    }
  };

  return (
    <div data-testid="report-receipt">
      <h2 ref={heading} tabIndex={-1} className="text-cdf-h1 font-semibold">
        {t("portal.successTitle")}
      </h2>
      <CDFAlert tone="warning">{t("portal.successIntro")}</CDFAlert>
      <CDFCard>
        {[
          { label: t("portal.reportRef"), value: reportRef, testId: "receipt-ref" },
          { label: t("portal.secret"), value: secret, testId: "receipt-secret" },
        ].map((item) => (
          <div key={item.testId} className="mb-4 flex flex-wrap items-center gap-3">
            <span className="w-32 font-semibold">{item.label}</span>
            <code
              dir="ltr"
              className="rounded-cdf-sm bg-cdf-surface-subtle px-3 py-2 text-lg tracking-wider"
              data-testid={item.testId}
            >
              {item.value}
            </code>
            <button
              type="button"
              className={buttonClass("secondary")}
              onClick={() => copy(item.label, item.value)}
              aria-label={copied === item.label ? undefined : t("portal.copyItem", { item: item.label })}
            >
              {copied === item.label ? t("portal.copied") : t("portal.copy")}
            </button>
          </div>
        ))}
        <p aria-live="polite" className="sr-only">
          {copied ? t("portal.copied") : ""}
        </p>
      </CDFCard>
      {attachmentsEnabled ? (
        <AttachmentUploader locale={locale} reportRef={reportRef} secret={secret} source="REPORT" />
      ) : null}
      <Link href="/" className={buttonClass("primary")}>
        {t("portal.savedConfirm")}
      </Link>
    </div>
  );
}
