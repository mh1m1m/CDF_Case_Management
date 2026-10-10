"use client";
import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { createTranslator, formatDateTime, type Locale, type MessageKey } from "@cdf/i18n";
import {
  CDFAlert,
  CDFBadge,
  CDFCard,
  CDFField,
  CDFTimeline,
  buttonClass,
  inputClass,
  textareaClass,
} from "@cdf/ui";
import { getStatusAction, postMessageAction, type StatusResult } from "./actions";

/** Credentials live only in component state for this page view; never in storage, cookies or URLs. */
export function FollowUp({ locale }: { locale: Locale }) {
  const t = createTranslator(locale);
  const [creds, setCreds] = useState<{ reportRef: string; secret: string } | null>(null);
  const [result, setResult] = useState<StatusResult | null>(null);
  const [replySent, setReplySent] = useState(false);
  const [pending, startTransition] = useTransition();
  // The view swaps between the form and the status card, and the submit button is disabled while
  // pending, so focus would fall to <body>. Say where it goes after each swap (WCAG 2.4.3).
  const focusNext = useRef<"status" | "reportRef" | "body" | null>(null);
  const statusView = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === "status") {
      // CDFCard owns its heading element, so make the first card heading programmatically focusable.
      const heading = statusView.current?.querySelector<HTMLElement>("h2");
      if (heading) {
        heading.tabIndex = -1;
        heading.focus();
      }
    } else if (target) {
      document.getElementById(target)?.focus();
    }
  }, [result, creds]);

  const open = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = { reportRef: String(data.get("reportRef") ?? ""), secret: String(data.get("secret") ?? "") };
    startTransition(async () => {
      const r = await getStatusAction(next.reportRef, next.secret);
      focusNext.current = r.status === "ok" ? "status" : "reportRef";
      setResult(r);
      setCreds(r.status === "ok" ? next : null);
    });
  };

  const reply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!creds) return;
    const form = event.currentTarget;
    const body = String(new FormData(form).get("body") ?? "");
    startTransition(async () => {
      const r = await postMessageAction(creds.reportRef, creds.secret, body);
      focusNext.current = r.status === "ok" ? "body" : "reportRef";
      setResult(r);
      if (r.status === "ok") {
        setReplySent(true);
        form.reset();
      }
    });
  };

  if (result?.status === "ok" && creds) {
    const report = result.report;
    return (
      <div ref={statusView} data-testid="report-status">
        <CDFCard
          title={`${t("portal.reportRef")}: ${report.reportRef}`}
          actions={
            <button
              type="button"
              className={buttonClass("ghost")}
              onClick={() => {
                focusNext.current = "reportRef";
                setCreds(null);
                setResult(null);
              }}
            >
              {t("portal.signOutFollowUp")}
            </button>
          }
        >
          <p className="mb-2">
            <span className="me-2 font-semibold">{t("portal.status")}</span>
            <CDFBadge tone="info" testId="public-status">
              {t(`publicStatus.${report.status}` as MessageKey)}
            </CDFBadge>
          </p>
          <p className="text-sm text-cdf-text-secondary">
            {t("portal.receivedAt")}: {formatDateTime(locale, report.receivedAt)}
          </p>
        </CDFCard>
        <CDFCard title={t("portal.messages")}>
          <CDFTimeline
            testId="report-messages"
            empty={t("portal.noMessages")}
            items={report.messages.map((m, i) => ({
              id: String(i),
              title: m.direction === "FROM_REPORTER" ? t("portal.fromYou") : t("portal.fromCdf"),
              meta: formatDateTime(locale, m.createdAt),
              body: m.body,
            }))}
          />
        </CDFCard>
        {report.canReply ? (
          <CDFCard>
            {replySent ? <CDFAlert tone="success">{t("portal.replySent")}</CDFAlert> : null}
            <form onSubmit={reply}>
              <CDFField id="body" label={t("portal.reply")}>
                <textarea
                  id="body"
                  name="body"
                  required
                  maxLength={4000}
                  className={textareaClass}
                  rows={4}
                />
              </CDFField>
              <button
                type="submit"
                className={buttonClass("primary")}
                disabled={pending}
                data-testid="send-reply"
              >
                {t("portal.sendReply")}
              </button>
            </form>
          </CDFCard>
        ) : (
          <CDFAlert tone="info">{t("portal.closedNotice")}</CDFAlert>
        )}
      </div>
    );
  }

  return (
    <CDFCard>
      {result?.status === "not_found" ? (
        <CDFAlert tone="danger" testId="follow-up-error">
          {t("portal.invalidCredentials")}
        </CDFAlert>
      ) : null}
      {result?.status === "error" ? (
        <CDFAlert tone="danger" testId="follow-up-error">
          {t("errors.withReference", { message: t(`errors.${result.kind}` as MessageKey), ref: result.ref })}
        </CDFAlert>
      ) : null}
      <form onSubmit={open} data-testid="follow-up-form">
        <CDFField id="reportRef" label={t("portal.reportRef")}>
          <input
            id="reportRef"
            name="reportRef"
            required
            autoComplete="off"
            spellCheck={false}
            dir="ltr"
            className={inputClass}
          />
        </CDFField>
        <CDFField id="secret" label={t("portal.secret")}>
          <input
            id="secret"
            name="secret"
            type="password"
            required
            autoComplete="off"
            spellCheck={false}
            dir="ltr"
            className={inputClass}
          />
        </CDFField>
        <button type="submit" className={buttonClass("primary")} disabled={pending} data-testid="open-report">
          {t("portal.check")}
        </button>
      </form>
    </CDFCard>
  );
}
