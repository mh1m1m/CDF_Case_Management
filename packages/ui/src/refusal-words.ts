import type { MessageKey, Translator } from "@cdf/i18n";

const REFUSAL_TITLES: Record<string, MessageKey> = {
  UNAUTHENTICATED: "errors.title.UNAUTHENTICATED",
  NOT_FOUND: "errors.title.NOT_FOUND",
  FORBIDDEN: "errors.title.FORBIDDEN",
  INVALID: "errors.title.INVALID",
  CONFLICT: "errors.title.CONFLICT",
  RATE_LIMITED: "errors.title.RATE_LIMITED",
  UNAVAILABLE: "errors.title.UNAVAILABLE",
};

/** The class of a refused command as a heading (UX-078); an unknown class reads as unavailable. */
export const refusalTitle = (kind: string): MessageKey => REFUSAL_TITLES[kind] ?? "errors.title.UNAVAILABLE";

/**
 * What a refused command said: the message for its code in the first section that has one (`codes` by default),
 * else the generic message for its class. Only codes are looked up, so the words are always the catalogue's.
 */
export function refusalMessage(
  t: Translator,
  kind: string,
  detail?: string,
  codeSections: readonly string[] = ["codes"],
): string {
  const generic = `errors.${kind}` as MessageKey;
  if (!detail) return t(generic);
  for (const section of codeSections) {
    const key = `${section}.${detail}` as MessageKey;
    const message = t(key);
    if (message !== key) return message;
  }
  return t(generic);
}
