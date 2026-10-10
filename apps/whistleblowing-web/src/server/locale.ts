import "server-only";
import { cookies } from "next/headers";
import { DEFAULT_LOCALE, createTranslator, isLocale, type Locale } from "@cdf/i18n";

export const LOCALE_COOKIE = "cdf_locale";

export async function getLocale(): Promise<Locale> {
  const value = (await cookies()).get(LOCALE_COOKIE)?.value;
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export async function getTranslator() {
  return createTranslator(await getLocale());
}
