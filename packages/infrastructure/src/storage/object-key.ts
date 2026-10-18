// Object keys are produced by the database (api.register_evidence_version, public_api.register_report_attachment for
// reporter attachments, ADR-015, and api.register_committee_record_document for the signed committee minutes, ADR-061)
// and never by user input.
// Adapters still refuse anything else, so a bug elsewhere cannot become a path traversal (threat T05).
const UUID = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
export const OBJECT_KEY_PATTERN = new RegExp(
  `^(?:cases/${UUID}/evidence/${UUID}/${UUID}|reports/${UUID}/attachments/${UUID}|committee-records/${UUID}/${UUID}/${UUID})$`,
);

export function assertObjectKey(objectKey: string): string {
  if (!OBJECT_KEY_PATTERN.test(objectKey)) throw new Error("Invalid evidence object key");
  return objectKey;
}

export const QUARANTINE_BUCKET = "evidence-quarantine";
export const VAULT_BUCKET = "evidence-vault";
