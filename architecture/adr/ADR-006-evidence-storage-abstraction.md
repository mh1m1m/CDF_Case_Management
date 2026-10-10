# ADR-006: Evidence storage abstraction

- **Status:** Accepted (2026-10-07); implemented in Phase 7 with Amendment 1 (2026-10-07)
- **Protocol:** §24–§28, §75

## Decision

- Port `EvidenceStorage { putQuarantine, promoteToVault, openReadStream, exists }`; no delete or overwrite method exists on the port. (`createShortLivedDownload` was removed by Amendment 1.)
- Prototype adapter `SupabaseEvidenceStorage`: private buckets `evidence-quarantine` and `evidence-vault`, object key `cases/{case_uuid}/evidence/{evidence_uuid}/{version_uuid}`, `upsert: false`. Called only from server code after `authz.can_*` checks pass inside the DB transaction. `storage.objects` has no policies granting `anon`/`authenticated` access to these buckets.
- Local adapter `LocalFilesystemEvidenceStorage` for environments without the storage service (exclusive-create writes, read-only files). PRODUCTION_SUBSTITUTION_REQUIRED.
- Ingestion pipeline: quarantine → extension allow-list → MIME sniffing → size limit → filename sanitisation → SHA-256 → `MalwareScanner` (prototype `MockMalwareScanner`, PRODUCTION_SUBSTITUTION_REQUIRED) → evidence + version records → vault promotion → custody event → audit event.

## Amendment 1 (2026-10-07, Phase 7 implementation)

- **No download URLs.** `createShortLivedDownload` is dropped from the port. The investigation BFF streams the bytes itself (`/cases/{id}/evidence/{versionId}/download`) after `api.open_evidence_version()` has authorised the request and recorded the custody and audit events in the same transaction. The browser never receives a storage URL, signed or otherwise (CLAUDE.md §3), and the production adapter needs no URL-signing capability. Responses are download-only: `Content-Disposition: attachment`, `nosniff`, `no-store`, `Content-Security-Policy: default-src 'none'; sandbox`.
- **The database owns the object key.** `api.register_evidence_version()` generates `cases/{case}/evidence/{evidence}/{version}` from three UUIDs; a check constraint and a unique index enforce the scheme; application roles cannot select the column. Only `api.open_evidence_version()` returns a key, to server code, and only for an `AVAILABLE` version the caller may download.
- **Two-phase protocol.** `register` (version `QUARANTINED`) → adapter quarantine write → scanner → `complete` (`AVAILABLE`, requires scan status `CLEAN`) or `reject` (`REJECTED` with `MALWARE_DETECTED`, `SCAN_UNAVAILABLE` or `STORAGE_FAILURE`). Only the uploader can complete or reject, exactly once. `AVAILABLE` and `REJECTED` versions and every custody event are immutable for every role, the table owner included; new content is a new version. An `UNSCANNED` result rejects the version rather than storing it unscanned.
- **Strict custody order.** `evidence.custody_event.seq` is an identity column, because `now()` is constant within a transaction and timestamps alone cannot order events.
- **Authorization.** `authz.can_view_evidence` = `can_view_case` ∧ item classification ≤ viewer clearance; `can_download_evidence` adds `EVIDENCE_DOWNLOAD`; `can_upload_evidence` requires `EVIDENCE_UPLOAD`, an `ACTIVE` visible case and an assignment as owner, lead or investigator (or `CASE_EDIT_ALL`). A viewer-only grant can see that evidence exists but can neither upload nor download.
- **Scanner contract.** `MalwareScanner.scan(content, { contentType, objectKey })` returns `CLEAN | INFECTED | UNSCANNED` with the scanner name recorded on the version. `MockMalwareScanner` flags only the EICAR test signature.

## Production mapping

Alibaba OSS with retention/WORM policies, KMS-managed server-side encryption, and a real malware scanning service. See `PRODUCTION_MAPPING.md` rows for `SupabaseEvidenceStorage`, `LocalFilesystemEvidenceStorage` and `MockMalwareScanner`.
