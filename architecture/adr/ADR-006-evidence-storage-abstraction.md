# ADR-006: Evidence storage abstraction

- **Status:** Accepted (2026-10-07); implementation in Phase 7
- **Protocol:** §24–§28, §75

## Decision

- Port `EvidenceStorage { putQuarantine, promoteToVault, openReadStream, createShortLivedDownload, exists }`; no delete or overwrite method exists on the port.
- Prototype adapter `SupabaseEvidenceStorage`: private buckets `evidence-quarantine` and `evidence-vault`, object key `cases/{case_uuid}/evidence/{evidence_uuid}/{version_uuid}`, `upsert: false`. Called only from server code after `authz.can_*` checks pass inside the DB transaction. `storage.objects` has no policies granting `anon`/`authenticated` access to these buckets.
- Local adapter `LocalFilesystemEvidenceStorage` for environments without the storage service (exclusive-create writes, read-only files). PRODUCTION_SUBSTITUTION_REQUIRED.
- Ingestion pipeline: quarantine → extension allow-list → MIME sniffing → size limit → filename sanitisation → SHA-256 → `MalwareScanner` (prototype `MockMalwareScanner`, PRODUCTION_SUBSTITUTION_REQUIRED) → evidence + version records → vault promotion → custody event → audit event.

## Production mapping

Alibaba OSS with retention/WORM policies, KMS-managed server-side encryption, and a real malware scanning service.
