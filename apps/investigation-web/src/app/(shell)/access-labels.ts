// How an access basis reads to people. Form-scoped access (UX redesign S3; ADR-016 D2, path (a)) is coded
// '<form code>:<instance no>' by the database; people read the form's name and number, never a raw code.
import { formDisplayNumber, getFormDefinition, parseFormAccessCode } from "@cdf/domain";
import { isolate, type Translator } from "@cdf/i18n";

export function formAccessLabel(t: Translator, code: string): string {
  const parsed = parseFormAccessCode(code);
  if (!parsed) return t("myAccess.basis.FORM_ACCESS");
  const def = getFormDefinition(parsed.formCode);
  const number = isolate(formDisplayNumber(parsed.formCode, parsed.instanceNo));
  return def ? `${t.locale === "ar" ? def.nameAr : def.nameEn} · ${number}` : number;
}
