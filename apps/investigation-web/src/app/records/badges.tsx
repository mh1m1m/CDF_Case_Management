// Records badges. Every badge carries its meaning in text, never colour alone (WCAG 1.4.1).
import type { RecordsState } from "@cdf/contracts";
import type { MessageKey, Translator } from "@cdf/i18n";
import { CDFBadge } from "@cdf/ui";

export function RecordsStateBadge({
  state,
  t,
  testId,
}: {
  state: RecordsState;
  t: Translator;
  testId?: string;
}) {
  const tone = state === "DISPOSED" ? "neutral" : state === "ACTIVE" ? "info" : "warning";
  return (
    <CDFBadge tone={tone} {...(testId ? { testId } : {})}>
      {t(`records.state.${state}` as MessageKey)}
    </CDFBadge>
  );
}

export function LegalHoldBadge({ status, t, testId }: { status: string; t: Translator; testId?: string }) {
  const active = status === "ACTIVE";
  return (
    <CDFBadge tone={active ? "danger" : "neutral"} {...(testId ? { testId } : {})}>
      {t(active ? "records.holdStatus.ACTIVE" : "records.holdStatus.NONE")}
    </CDFBadge>
  );
}
