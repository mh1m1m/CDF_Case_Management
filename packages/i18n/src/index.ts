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

const RIYADH = "Asia/Riyadh";
/** Gregorian, Latin digits. `ar-SA` alone would default to the Hijri calendar and Arabic-Indic digits. */
const GREGORIAN: Record<Locale, string> = { ar: "ar-SA-u-ca-gregory-nu-latn", en: "en-GB" };
const UMM_AL_QURA: Record<Locale, string> = {
  ar: "ar-SA-u-ca-islamic-umalqura-nu-latn",
  en: "en-GB-u-ca-islamic-umalqura",
};

export function formatDateTime(locale: Locale, value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(GREGORIAN[locale], {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: RIYADH,
  }).format(d);
}

export function formatDate(locale: Locale, value: string | Date): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(GREGORIAN[locale], {
    dateStyle: "medium",
    timeZone: RIYADH,
  }).format(d);
}

/** One piece of a formal record date, in the manner of `Intl.DateTimeFormat.prototype.formatToParts`. */
export interface RecordDatePart {
  type: "gregorian" | "hijri" | "time" | "literal";
  value: string;
}

/**
 * A date on a formal generated record (DEC-51): the Gregorian date first and the Hijri date second, both for the
 * same day in Riyadh ("13 October 2026 (2 Jumada I 1448H)", «13 أكتوبر 2026 (2 جمادى الأولى 1448هـ)»), then the
 * time when asked for. The Hijri date comes from the platform's Umm al-Qura calendar, never from a table kept here;
 * a runtime without that calendar gets the Gregorian date alone rather than a wrong Hijri one. Only the rendering
 * changes: the stored value stays the canonical timestamp. Operational screens keep formatDate and formatDateTime.
 * An invalid value throws a RangeError, as those do.
 */
export function formatRecordDateToParts(
  locale: Locale,
  value: string | Date,
  { withTime = false }: { withTime?: boolean } = {},
): RecordDatePart[] {
  const d = typeof value === "string" ? new Date(value) : value;
  const gregorian: RecordDatePart = {
    type: "gregorian",
    value: new Intl.DateTimeFormat(GREGORIAN[locale], {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: RIYADH,
    }).format(d),
  };
  const hijri = hijriDate(locale, d);
  const date = hijri
    ? fill(translate(locale, "recordDate.dual"), { gregorian: [gregorian], hijri: [hijri] })
    : [gregorian];
  if (!withTime) return date;
  const time: RecordDatePart = {
    type: "time",
    value: new Intl.DateTimeFormat(GREGORIAN[locale], { timeStyle: "short", timeZone: RIYADH }).format(d),
  };
  return fill(translate(locale, "recordDate.withTime"), { date, time: [time] });
}

/** The same date as one line of text, for a generated document or message. */
export function formatRecordDate(
  locale: Locale,
  value: string | Date,
  options?: { withTime?: boolean },
): string {
  return formatRecordDateToParts(locale, value, options)
    .map((p) => p.value)
    .join("");
}

function hijriDate(locale: Locale, d: Date): RecordDatePart | null {
  const f = new Intl.DateTimeFormat(UMM_AL_QURA[locale], {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: RIYADH,
  });
  // Without the calendar, ICU falls back to another one silently: the numbers would be Gregorian.
  if (f.resolvedOptions().calendar !== "islamic-umalqura") return null;
  const p: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const { type, value } of f.formatToParts(d)) p[type] = value;
  if (!p.day || !p.month || !p.year) return null;
  return {
    type: "hijri",
    value: translate(locale, "recordDate.hijri", { day: p.day, month: p.month, year: p.year }),
  };
}

/** Expands a `{name}` template into parts; the template's own words and punctuation become literals. */
function fill(template: string, values: Record<string, RecordDatePart[]>): RecordDatePart[] {
  const parts: RecordDatePart[] = [];
  let at = 0;
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    if (m.index > at) parts.push({ type: "literal", value: template.slice(at, m.index) });
    parts.push(...(values[m[1] ?? ""] ?? []));
    at = m.index + m[0].length;
  }
  if (at < template.length) parts.push({ type: "literal", value: template.slice(at) });
  return parts;
}

/** A whole number of days ("3 days", «3 أيام») with the locale's own plural forms. */
export function formatDays(locale: Locale, days: number): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-SA-u-nu-latn" : "en-GB", {
    style: "unit",
    unit: "day",
    unitDisplay: "long",
  }).format(days);
}

/**
 * Wraps a value (a name, a date, a list) in first-strong isolates (U+2068 … U+2069) before it goes into a translated
 * sentence, so it keeps its own direction: an Arabic date or a Latin name does not reorder the words around it.
 * In JSX, use <bdi> instead.
 */
export function isolate(value: string): string {
  return `\u2068${value}\u2069`;
}

/** "A, B or C" («أ أو ب أو ج») with the locale's own words and punctuation. */
export function formatList(
  locale: Locale,
  items: readonly string[],
  type: "conjunction" | "disjunction" = "conjunction",
): string {
  return new Intl.ListFormat(locale, { style: "long", type }).format(items);
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
