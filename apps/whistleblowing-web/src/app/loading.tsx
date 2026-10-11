// Translated loading state while a portal page is prepared (UX-080). The portal calls notFound() nowhere, so
// streaming this boundary changes no status code; unknown addresses still answer 404.
// No-JS constraint (CDF-87): portal pages await only the locale, so the server sends their content inline and
// this fallback reaches the browser only on client navigations. A portal page that awaited slow I/O would be
// streamed behind this fallback in a hidden block that only JavaScript reveals, so a page like that needs its
// own decision first. security-no-js-forms.spec.ts loads and fills each form with JavaScript off.
import { getTranslator } from "@/server/locale";

export default async function Loading() {
  const t = await getTranslator();
  return (
    <p role="status" className="py-8 text-cdf-text-secondary" data-testid="route-loading">
      {t("system.loading")}
    </p>
  );
}
