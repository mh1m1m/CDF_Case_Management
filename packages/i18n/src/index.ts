/**
 * Bilingual messages. Arabic (RTL) is the default and is implemented first-class, not as a
 * translation patch (protocol §42). Every user-facing string comes from these catalogs.
 */
import { ar } from "./messages/ar";
import { en } from "./messages/en";
import type { Messages } from "./messages/en";

export type Locale = "ar" | "en";
export const LOCALES: readonly Locale[] = ["ar", "en"] as const;
export const DEFAULT_LOCALE: Locale = "ar";
export type { Messages };

const catalogs: Record<Locale, Messages> = { ar, en };

export function isLocale(value: unknown): value is Locale {
  return value === "ar" || value === "en";
}

export function directionOf(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

export function messagesFor(locale: Locale): Messages {
  return catalogs[locale];
}

type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

export type MessageKey = Leaves<Messages>;

/** Look up a message by dotted key and interpolate `{name}` placeholders. */
export function translate(
  locale: Locale,
  key: MessageKey,
  vars: Record<string, string | number> = {},
): string {
  let node: unknown = catalogs[locale];
  for (const part of key.split(".")) {
    node = (node as Record<string, unknown> | undefined)?.[part];
  }
  if (typeof node !== "string") return key;
  return node.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}

export function formatDateTime(locale: Locale, value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-SA-u-ca-gregory-nu-latn" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Riyadh",
  }).format(d);
}

export function formatDate(locale: Locale, value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-SA-u-ca-gregory-nu-latn" : "en-GB", {
    dateStyle: "medium",
    timeZone: "Asia/Riyadh",
  }).format(d);
}

/**
 * Translates a dynamic code (e.g. an enum value or blocking-reason code) under a catalog section,
 * falling back to `fallback` when the code has no message.
 */
export function translateCode(locale: Locale, section: string, code: string, fallback: MessageKey): string {
  const key = `${section}.${code}`;
  const value = translate(locale, key as MessageKey);
  return value === key ? translate(locale, fallback) : value;
}

export type Translator = ((key: MessageKey, vars?: Record<string, string | number>) => string) & {
  locale: Locale;
  code: (section: string, code: string, fallback?: MessageKey) => string;
};

export function createTranslator(locale: Locale): Translator {
  const t = ((key: MessageKey, vars?: Record<string, string | number>) =>
    translate(locale, key, vars)) as Translator;
  t.locale = locale;
  t.code = (section, code, fallback = "errors.CONFLICT") => translateCode(locale, section, code, fallback);
  return t;
}
