// Server side only: imported by route handlers, never by a client component.
// The empty BCP-1 continuity workbook (ADR-034 D1) with bilingual labels from the message catalogs. The same bytes
// are committed as infrastructure/bcp/BCP-1_template.xlsx; bcp-template.test.ts keeps the two equal.
import { BCP_TEMPLATE_VERSION } from "@cdf/contracts";
import { messagesFor } from "@cdf/i18n";
import { buildBcpTemplate, type BcpTemplateText } from "@cdf/infrastructure";

export const BCP_TEMPLATE_FILE_NAME = `${BCP_TEMPLATE_VERSION}_template.xlsx`;

export function bcpTemplateText(): BcpTemplateText {
  const en = messagesFor("en").bcpTemplate;
  const ar = messagesFor("ar").bcpTemplate;
  const columns = (m: typeof en) => m.columns as Record<string, string>;
  return {
    label: (code) => {
      const label = [columns(en)[code], columns(ar)[code]].filter(Boolean).join(" / ");
      if (!label) throw new Error(`no label for BCP column ${code}`);
      return label;
    },
    readme: [...Object.values(en.readme), "", ...Object.values(ar.readme)],
  };
}

export function bcpTemplateBytes(): Uint8Array {
  return buildBcpTemplate(bcpTemplateText());
}
