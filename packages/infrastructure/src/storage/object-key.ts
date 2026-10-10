// Object keys are produced by the database (api.register_evidence_version) and never by user input.
// Adapters still refuse anything else, so a bug elsewhere cannot become a path traversal (threat T05).
const UUID = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
export const OBJECT_KEY_PATTERN = new RegExp(`^cases/${UUID}/evidence/${UUID}/${UUID}$`);

export function assertObjectKey(objectKey: string): string {
  if (!OBJECT_KEY_PATTERN.test(objectKey)) throw new Error("Invalid evidence object key");
  return objectKey;
}

export const QUARANTINE_BUCKET = "evidence-quarantine";
export const VAULT_BUCKET = "evidence-vault";
