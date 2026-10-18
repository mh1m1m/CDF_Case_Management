"use client";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { createTranslator, type Locale } from "@cdf/i18n";
import { CDFAlert } from "./components";
import { NO_REFUSAL_NOTICE, refusalNotice, type Refusal } from "./refusal-notice-state";
import { refusalMessage, refusalTitle } from "./refusal-words";

/** What a command form tells the page-level refusal notice (CDF-232). */
export interface CDFRefusalNotices {
  /** The form's command answered: its refusal, or null for anything else. */
  answered(formId: string, refusal: Refusal | null): void;
  /** The form shows its refusal itself, so the page need not. */
  shownByForm(formId: string): void;
  /** The form is on the page; the returned function says it left. */
  register(formId: string): () => void;
}

const RefusalNoticesContext = createContext<CDFRefusalNotices | null>(null);

/** The page's refusal notice, or null outside a page that has one (the form then behaves as before). */
export const useRefusalNotices = () => useContext(RefusalNoticesContext);

/**
 * CDF-232: the page-level refusal notice. A form that leaves the page with its command's refusal (another user's
 * action moved its subject on, so the page read again no longer offers it) hands the refusal here, and the notice
 * shows it at the top of the page: the class of refusal, the command's own words for its code and the reference,
 * from packages/i18n, and nothing else (`refusal-notice-state.ts`). A form still on the page shows its refusal
 * itself, so there is only ever one. The notice is in memory only and clears when `navigationKey` changes (the app
 * passes its path) and when the next command answers.
 */
export function CDFRefusalNoticeProvider({
  locale,
  navigationKey,
  children,
}: {
  locale: Locale;
  navigationKey: string;
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(refusalNotice, NO_REFUSAL_NOTICE);
  const onPage = useRef(new Set<string>());
  const notices = useMemo<CDFRefusalNotices>(
    () => ({
      answered: (formId, refusal) =>
        dispatch({ type: "answered", formId, refusal, mounted: onPage.current.has(formId) }),
      shownByForm: (formId) => dispatch({ type: "shownByForm", formId }),
      register: (formId) => {
        onPage.current.add(formId);
        return () => {
          onPage.current.delete(formId);
          dispatch({ type: "formLeft", formId });
        };
      },
    }),
    [],
  );

  // Cleared on navigation, before the new page is painted (the first key is the page the notice starts on).
  const lastKey = useRef(navigationKey);
  useLayoutEffect(() => {
    if (lastKey.current === navigationKey) return;
    lastKey.current = navigationKey;
    dispatch({ type: "navigated" });
  }, [navigationKey]);

  return (
    <RefusalNoticesContext.Provider value={notices}>
      {state.shown ? <RefusalNotice locale={locale} refusal={state.shown} /> : null}
      {children}
    </RefusalNoticesContext.Provider>
  );
}

function RefusalNotice({ locale, refusal }: { locale: Locale; refusal: Refusal }) {
  const t = createTranslator(locale);
  const box = useRef<HTMLDivElement>(null);
  // The form that had focus left the page with it, so focus would fall to the page: it moves to the notice, at the
  // top of the content, and the next Tab continues from there (WCAG 2.4.3). Focus the user placed elsewhere stays.
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) box.current?.focus();
  }, [refusal]);
  return (
    <div ref={box} tabIndex={-1} data-testid="refusal-notice" data-kind={refusal.kind}>
      {/* The alert is the notice's one live region; the form's own alert left the page with the form. */}
      <CDFAlert tone="danger" title={t(refusalTitle(refusal.kind))}>
        <p>
          {t("errors.withReference", {
            message: refusalMessage(t, refusal.kind, refusal.detail, refusal.codeSections),
            ref: refusal.ref,
          })}
        </p>
      </CDFAlert>
    </div>
  );
}
