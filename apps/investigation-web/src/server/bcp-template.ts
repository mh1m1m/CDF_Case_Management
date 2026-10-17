// Server side only: imported by route handlers, never by a client component.
// The empty continuity workbooks with bilingual labels from the message catalogs: BCP-1 for a case (ADR-034 D1) and
// BCP-C1 for a committee proceeding (migration 2110, ADR-047). The same bytes are committed as
// infrastructure/bcp/<version>_template.xlsx; bcp-template.test.ts keeps them equal.
import {
  BCP_COMMITTEE_TEMPLATE_VERSION,
  BCP_TEMPLATE_VERSION,
  type BcpTemplateVersion,
} from "@cdf/contracts";
import { messagesFor } from "@cdf/i18n";
import { buildBcpTemplate, type BcpTemplateText } from "@cdf/infrastructure";

export const BCP_TEMPLATE_FILE_NAME = `${BCP_TEMPLATE_VERSION}_template.xlsx`;
export const BCP_COMMITTEE_TEMPLATE_FILE_NAME = `${BCP_COMMITTEE_TEMPLATE_VERSION}_template.xlsx`;

export function bcpTemplateText(version: BcpTemplateVersion = BCP_TEMPLATE_VERSION): BcpTemplateText {
  const [en, ar] = [messagesFor("en"), messagesFor("ar")];
  const columns = (m: typeof en) => m.bcpTemplate.columns as Record<string, string>;
  const readme = (m: typeof en) =>
    Object.values(version === BCP_TEMPLATE_VERSION ? m.bcpTemplate.readme : m.bcpCommitteeTemplate.readme);
  return {
    label: (code) => {
      const label = [columns(en)[code], columns(ar)[code]].filter(Boolean).join(" / ");
      if (!label) throw new Error(`no label for BCP column ${code}`);
      return label;
    },
    readme: [...readme(en), "", ...readme(ar)],
  };
}

export function bcpTemplateBytes(version: BcpTemplateVersion = BCP_TEMPLATE_VERSION): Uint8Array {
  return buildBcpTemplate(bcpTemplateText(version), version);
}
