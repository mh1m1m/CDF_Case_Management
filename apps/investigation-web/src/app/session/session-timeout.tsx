"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { createTranslator, type Locale } from "@cdf/i18n";
import { buttonClass } from "@cdf/ui";
import { signOutAction } from "../login/actions";
import { extendSessionAction } from "./actions";

/** Seconds of warning before the idle limit (CDF-57: warn and extend, chosen 2026-10-10). */
const WARNING_SECONDS = 120;

type Phase = "active" | "warning" | "ended";

/**
 * Warns before the server's idle limit signs the user out and lets them extend it (WCAG 2.2.1 Timing Adjustable).
 * The browser only knows about its own requests, so the timer restarts on navigation and on form submits;
 * any other request the server sees only makes the warning appear early, never late. When time runs out the
 * page stays as it is, so unsaved text can still be copied, and a dialog offers sign-in again.
 */
export function SessionTimeout({ idleSeconds, locale }: { idleSeconds: number; locale: Locale }) {
  const t = createTranslator(locale);
  const dialog = useRef<HTMLDialogElement>(null);
  const pathname = usePathname();
  const [phase, setPhase] = useState<Phase>("active");
  const [deadline, setDeadline] = useState(() => Date.now() + idleSeconds * 1000);
  const minutes = Math.round(idleSeconds / 60);

  // Server activity this page can see: navigations and form submissions.
  useEffect(() => {
    const restart = () => {
      setDeadline(Date.now() + idleSeconds * 1000);
      setPhase((p) => (p === "ended" ? p : "active"));
    };
    restart();
    document.addEventListener("submit", restart, true);
    return () => document.removeEventListener("submit", restart, true);
  }, [pathname, idleSeconds]);

  useEffect(() => {
    const now = Date.now();
    const warn = setTimeout(
      () => setPhase((p) => (p === "active" ? "warning" : p)),
      deadline - now - WARNING_SECONDS * 1000,
    );
    const end = setTimeout(() => setPhase("ended"), deadline - now);
    return () => {
      clearTimeout(warn);
      clearTimeout(end);
    };
  }, [deadline]);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (phase === "active") {
      if (el.open) el.close();
    } else if (!el.open) {
      el.showModal();
    }
  }, [phase]);

  const stay = async () => {
    const ok = await extendSessionAction().catch(() => false);
    if (ok) {
      setDeadline(Date.now() + idleSeconds * 1000);
      setPhase("active");
    } else {
      setPhase("ended");
    }
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby="session-dialog-title"
      aria-describedby="session-dialog-body"
      data-testid="session-dialog"
      data-phase={phase}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-cdf-lg border border-cdf-border bg-cdf-surface p-6 text-cdf-text shadow-cdf backdrop:bg-black/40"
    >
      {phase === "ended" ? (
        <>
          <h2 id="session-dialog-title" className="text-cdf-h2 font-semibold">
            {t("session.endedTitle")}
          </h2>
          <p id="session-dialog-body" className="mt-2">
            {t("session.endedBody", { minutes })}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <a href="/login" className={buttonClass("primary")} data-testid="session-sign-in">
              {t("session.signInAgain")}
            </a>
          </div>
        </>
      ) : (
        <>
          <h2 id="session-dialog-title" className="text-cdf-h2 font-semibold">
            {t("session.warningTitle")}
          </h2>
          <p id="session-dialog-body" className="mt-2">
            {t("session.warningBody", { minutes: Math.round(WARNING_SECONDS / 60) })}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              className={buttonClass("primary")}
              onClick={stay}
              data-testid="session-stay"
            >
              {t("session.stay")}
            </button>
            <form action={signOutAction}>
              <button type="submit" className={buttonClass("ghost")}>
                {t("common.signOut")}
              </button>
            </form>
          </div>
        </>
      )}
    </dialog>
  );
}
