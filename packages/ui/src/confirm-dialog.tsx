"use client";
import { useEffect, useEffectEvent, useId, useRef } from "react";
import { buttonClass } from "./components";

/** What a consequential command does, said before it runs (UX-031, O08 §08.12). All text comes from @cdf/i18n. */
export interface CDFConfirmation {
  /** Dialog heading: the act as a question or a verb phrase ("Archive this case?"). */
  title: string;
  /** What happens when the user confirms. */
  whatHappens: string;
  /** Whether it can be undone, and how. */
  undo: string;
  /** Who is affected. */
  affected: string;
  /** The confirm button: repeats the trigger's verb ("Archive case"). */
  confirmLabel: string;
  /** The dismiss button ("Cancel", "Keep interview"). Default focus. */
  cancelLabel: string;
  /** Row labels for the three statements. */
  labels: { whatHappens: string; undo: string; affected: string };
  /** The confirm button's weight: "danger" (default) for an act that closes, removes or ends something. */
  tone?: "primary" | "danger";
}

/**
 * Modal confirmation on the native `<dialog>` (focus trap, Escape and the top layer come from the browser).
 * Cancel comes first and takes focus, so Enter or Escape never runs the command by accident. The dialog only gates
 * a command the user already chose; it changes no rule. `onClosed` lets the caller return focus to the trigger.
 */
export function CDFConfirmDialog({
  open,
  confirmation,
  onConfirm,
  onDismiss,
  onClosed,
}: {
  open: boolean;
  confirmation: CDFConfirmation;
  onConfirm: () => void;
  /** Cancel, Escape, or the browser closing the dialog. */
  onDismiss: () => void;
  /** After the dialog has closed, however it closed: the caller returns focus to its trigger (WCAG 2.4.3). */
  onClosed?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;
  const c = confirmation;
  const closed = useEffectEvent(() => onClosed?.());

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open) {
      if (!el.open) el.showModal();
      cancel.current?.focus();
      wasOpen.current = true;
      return;
    }
    if (el.open) el.close();
    if (wasOpen.current) {
      wasOpen.current = false;
      closed();
    }
  }, [open]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-testid="confirm-dialog"
      // Escape: dismiss through React state, so the dialog and the form never disagree about being open.
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
      onClose={() => {
        if (open) onDismiss();
      }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-cdf-lg border border-cdf-border bg-cdf-surface p-6 text-cdf-text shadow-cdf backdrop:bg-[var(--cdf-overlay)]"
    >
      <h2 id={titleId} className="text-cdf-h2 font-semibold">
        {c.title}
      </h2>
      <dl id={bodyId} className="mt-4 space-y-3">
        <div>
          <dt className="font-semibold">{c.labels.whatHappens}</dt>
          <dd data-testid="confirm-what">{c.whatHappens}</dd>
        </div>
        <div>
          <dt className="font-semibold">{c.labels.undo}</dt>
          <dd data-testid="confirm-undo">{c.undo}</dd>
        </div>
        <div>
          <dt className="font-semibold">{c.labels.affected}</dt>
          <dd data-testid="confirm-affected">{c.affected}</dd>
        </div>
      </dl>
      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <button
          ref={cancel}
          type="button"
          data-testid="confirm-cancel"
          className={buttonClass("secondary")}
          onClick={onDismiss}
        >
          {c.cancelLabel}
        </button>
        <button
          type="button"
          data-testid="confirm-submit"
          className={buttonClass(c.tone ?? "danger")}
          onClick={onConfirm}
        >
          {c.confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
