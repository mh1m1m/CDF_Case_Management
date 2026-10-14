# ADR-041: The evidence half of P11-G4, the Defence Packet and the prior-sanctions extract (migration 2050)

- **Status:** Proposed (2026-10-14). Linear CDF-196 (rebase decision application) and CDF-212 (ended-seat conflict declaration). Implemented in migration 2050 (Rebase PR-B, pending security review). Builds on ADR-006 (evidence), ADR-024 (grievance and defence), ADR-037 (notice kinds) and ADR-040 (owner decisions, 2030/2040).
- **Owner decisions** (recorded in `docs/business-architecture/OWNER_DECISIONS_FINALIZATION.md`):
  - DEC-F37 (2026-10-13): "Build the evidence half now that #55's evidence commands are on main ... Preserve evidence authorization, provenance, chain of custody, immutable versions, audit and purpose-bound access."
  - DEC-AMB-005, option B (2026-10-13): "Permit access only to prior final disciplinary sanctions, through a purpose-bound extract initiated/managed by the Secretary. No unrelated case allegations, evidence, investigations, or full case history. Restricted-source cases remain subject to Restricted Case Authority controls."
  - DEC-AMB-006, option C (2026-10-13): "Permit selected evidence through a purpose-bound Defence Packet, following review/redaction for reporter, witness, confidentiality, privilege, restricted information and other protected identities/content. This does not create general evidence access for the subject."
- **Coordinator defaults** (2026-10-14 11:26, accepted as proposed): "(1) packet items chosen and reviewed by evidence leads, reviewer ≠ chooser, secretary issues the notice but never sees evidence (DEC-09); (2) LEGAL_PRIVILEGE_RULE stays SOURCE_REQUIRED and a review cannot complete until it is recorded, so nothing reaches the subject (fail closed); (3) PACKET_EVIDENCE_DOWNLOAD=false, view-only. Keep each as a configurable with the default on the narrow side and a negative test per default."
- **CDF-212** (AGENT-09, relayed 2026-10-14 11:17): "make declare_meeting_conflict require member_seat_current the same way, with a negative test for the ended-seat case".
- **Protocol:** §18–§22, §24–§29, §39, §40, §65, §68, §82, §83, §87.

## Context

P11-G4 had two halves. The witness half shipped in 2010 (ADR-039). The evidence half waited for the evidence commands of #55, and DEC-F37 released it. Two owner decisions on the ambiguity register (PR #60) shape what a subject and a committee may learn from evidence and from other cases: DEC-AMB-006 lets the subject see selected, reviewed evidence for their defence, and DEC-AMB-005 lets the committee weigh the subject's prior final sanctions. Each grants a narrow read that did not exist before, so each is built as a purpose-bound path with its own guards, not as a widening of an existing predicate.

The ambiguity rows this migration answers are AMB-034, AMB-106, AMB-118, AMB-159, AMB-161, AMB-164, AMB-165, AMB-169, AMB-171 and AMB-191. Their tests are T-AMB-015, T-AMB-092, T-AMB-094, T-AMB-097, T-AMB-098, T-AMB-100, T-AMB-102 and T-AMB-111.

## Decision

### 1. Evidence exclusion (DEC-F37, AMB-161; T3-B2.3-112, T3-B2.3-144, S083, S118)

- `api.exclude_evidence(evidence, reason)`: an evidence lead (DEC-09: the case manager, owner or lead investigator) excludes an item on an active case. The exclusion is final and append-only (`evidence.exclusion`), numbered within the case for the formal record, and recorded as an `EXCLUDED` custody event.
- The item, its versions and its custody stay as they are. An excluded item takes no new version or rendition on any path (a trigger on `evidence.evidence_version`) and never enters a Defence Packet (T-AMB-094).
- `api.evidence_exclusion_record(exclusion)` generates the formal record (T3-B2.3-144) for whoever may see the item; anyone else gets NOT_FOUND.
- The catalogue follows: S083 maps to `EVIDENCE_EXCLUDED` (IMPLEMENTED), S118 is its duplicate, and the two forms map to the two commands. P11-G4 closes.

### 2. Custody exceptions and external transfers (AMB-164; T-AMB-097)

- `api.record_custody_exception(evidence, version?, kind, reason, external_reference?)`: the investigation team that handles the evidence (with EVIDENCE_UPLOAD) records a `CUSTODY_EXCEPTION` or an `EXTERNAL_TRANSFER`, which needs its external reference. A closed case takes it too (recording a fact grants nothing); an archived one does not.
- Each row is append-only, has a reason, and points at its own custody event. The pointer is checked by a trigger (same item, version, kind and case) rather than a foreign key, so `evidence.custody_event` keeps its append-only refusal for TRUNCATE.

### 3. Integrity on read (AMB-165; T-AMB-098)

- The BFF reads the stored bytes, computes their SHA-256 and compares it with the recorded hash before serving anything (`packages/application/src/evidence.ts`). On a mismatch it serves nothing, returns a generic error with a correlation id, and calls `api.report_evidence_integrity_failure(version, observed)`.
- The report is allowed to a reader who may download the version, or who views it through a released Defence Packet. It writes `evidence.integrity_failure` (append-only), an `INTEGRITY_FAILED` custody event, a BUSINESS event and a SECURITY event, and tells the case owner by template code.
- From then on the version is blocked for every reader on every path: `api.open_evidence_version` refuses it with the same SECURITY denial as for a missing version (its metadata says `integrity_failed`), a rendition cannot be made from it, it cannot enter a packet, and a released packet stops showing it.
- The version row itself never changes.

### 4. Redacted renditions (AMB-169, AMB-168; T-AMB-100)

- `api.register_evidence_rendition(source, file facts)`: an evidence lead registers a REDACTED version derived from an available, intact original of the same item. It goes through the same quarantine, scan and completion pipeline as any version.
- A rendition never becomes the item's current version; the original is untouched. No rendition of a rendition, and a forged row must name an original of the same item (trigger, `RENDITION_SOURCE_INVALID`).
- `rendition` and `derived_from_version_id` are immutable like the other content columns.

### 5. The Defence Packet (DEC-AMB-006, AMB-159, AMB-118, AMB-171; T-AMB-092, T-AMB-094, T-AMB-102)

- **Shape.** One open packet at a time per DEFENCE notice: `grievance.defence_packet`, its items (an original evidence version each) and one review per item. The notice itself still carries no evidence and no reporter field.
- **Who.** The case's evidence leads choose items and review them (default 1). The committee secretary issues and manages the notice but never sees evidence: they get NOT_FOUND on every packet command and read, since they hold no view of the case's records (DEC-09). An investigator who is not a lead is refused.
- **Review.** For each item the reviewer covers the six categories DEC-AMB-006 names (reporter, witness, confidentiality, privilege, restricted information, other protected) and then clears it as is, clears a redacted rendition of it, or withholds it with a note. The reviewer writes the title the subject will see, since the evidence title may itself identify someone. The LEGAL_PRIVILEGE_RULE in force is snapshotted on each clearance.
- **Release.** Submitting releases a packet when every item is reviewed, at least one is cleared, and every cleared item is still disclosable (not excluded, not integrity-failed). A restricted case's packet waits for its Restricted Case Authority, who never consents to a packet they made or submitted (`REQUESTER_CANNOT_CONSENT`, as CDF-208). A packet can be withdrawn; it never comes back.
- **The subject.** `api.my_defence_packet(notice)` lists the cleared items of released packets by their reviewed titles, with type and size only. `api.open_defence_packet_item(item)` gives server code the storage facts of the disclosed version under a neutral file name (`defence-item-N.ext`), with a disposition: INLINE while PACKET_EVIDENCE_DOWNLOAD is false. Each opening is a `PACKET_VIEWED` custody event and an audit event; a refused opening is a SECURITY denial, the same for a missing item. The subject never reaches the evidence tables, storage or the download gate.
- **Guards whatever the path.** Triggers enforce: draft-only items, originals of the packet's case only, one review per item, reviewer ≠ chooser while the setting holds, no clearance without the privilege rule, the release block, the authority's consent, and forward-only status. Items, reviews and authority decisions are append-only.
- **Notices** go by template code only: `DEFENCE_PACKET_APPROVAL_REQUESTED` to the authority, `DEFENCE_PACKET_RELEASED` to the subject (deep link to the notice).

### 6. The prior-sanctions extract (DEC-AMB-005, AMB-034, AMB-106; T-AMB-015)

- `api.request_sanction_extract(committee proceeding, subject, reason)`: the secretary of an open proceeding, cleared for its case and without a meeting conflict, asks for the final sanctions of one of the case's subjects in their other cases.
- A sanction is final when it has been executed and taken effect, its decision is not blocked (for example superseded), the grievance window of its decision notice has ended, and no grievance on it is open or cancelled it or sent it back for reinvestigation. Each row carries the sanction code and two dates, never a case, case number, allegation, finding, evidence or history.
- A row from a restricted case waits for that case's Restricted Case Authority (`api.decide_sanction_extract_row`, never the requester), who is told by template code and sees the row in `api.my_sanction_extract_approvals()`. Until it is approved it is invisible to the extract's readers.
- `api.sanction_extract_view(extract)`: the proceeding's secretary and seated members without a meeting conflict read the included rows within their clearance; every view is audited with a count. Anyone else gets NOT_FOUND.
- The two tables have RLS enabled with no policy and no grant: the commands and the view are the only way in.

### 7. CDF-212: a member whose seat has ended declares nothing

`api.declare_meeting_conflict` refuses a MEMBER participant whose seat is no longer current (`CONFLICT:SEAT_ENDED`), as `cast_vote`, `revise_vote`, `record_attendance` and the deliberation view already do. The negative test fails on 2030's function and passes on this one.

### 8. Configuration defaults and their negative tests

`grievance.defence_packet_policy` is effective-dated and migration-managed: a version only ever gets an end, never a change or a delete, and no application role writes it. No version in force reads as the narrow defaults.

| Setting                    | Default                 | Negative test (`tests/security/evidence-half-2050.spec.ts` unless named)                                                   |
| -------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `reviewer_must_differ`     | true                    | default 1: the chooser reviewing their own item is refused (`REVIEWER_IS_CHOOSER`), by the command and on the table        |
| `privilege_rule_reference` | null, SOURCE_REQUIRED   | default 2: clearing is refused while the rule is unrecorded (`LEGAL_PRIVILEGE_RULE_REQUIRED`); nothing reaches the subject |
| `packet_evidence_download` | false (AMB-171, DEC-67) | T-AMB-102 (`evidence-need-to-know.spec.ts`): the item opens INLINE, and the download gate returns nothing to the subject   |

A recorded policy version is the only way to change a default. Even with download allowed, the disposition becomes ATTACHMENT for the packet viewer and the evidence download gate stays closed to the subject.

## Consequences

- Every new table has RLS enabled, is default deny, and is select-only where it has a reader at all. No write grant to `anon` or `authenticated`. Every command is SECURITY DEFINER with `search_path = ''` and writes its audit event in the same transaction with ids, codes and counts; reasons and notes stay in their rows.
- No new permission. The rules use evidence leadership, defence management, committee seats and the Restricted Case Authority as they are. PLATFORM_ADMIN and DB_ADMIN gain nothing; protected identity is untouched.
- New commands are in the IDOR catalog (`api-idor.spec.ts`: four evidence probes in the main list and the 2050 group with its own outsiders) and in the audit walk (`audit-bypass.spec.ts`); the new reads are listed as not state-changing.
- **For security review**, what this record changes:
  - **Narrowed:** `api.open_evidence_version` (integrity), `api.complete_evidence_version` (a rendition is never current), `api.declare_meeting_conflict` (CDF-212), `evidence.protect_version` (two more immutable columns).
  - **Granted by owner decision, through purpose-bound paths only:** the subject reads cleared Defence Packet items (DEC-AMB-006); the secretary and seated members read the prior final sanctions of the subject (DEC-AMB-005). No `authz.*` predicate is widened for either.
  - **Read by the case's evidence leads:** packets, items, reviews (with their notes) and authority decisions, through the tables and `api.defence_packet_view`, which leaves out the notes.
- Widened checks (drop and re-add under the same name): the custody event types, and the notification object types (CASE, DEFENCE_PACKET, SANCTION_EXTRACT_APPROVAL).

## Not built here

- Committee evidence packets (AMB-065), physical evidence (AMB-167), screenshot capture metadata (AMB-168, first half) and defence attachments (AMB-155).
- The offline evidence package (AMB-202): migration 2110.
- Exports of evidence or packets stay refused (AMB-191, DEC-67 open; T-AMB-111).
- Report attachments are not covered by the integrity check; it covers evidence versions.
- `api.case_history` (2045) does not yet list the new events: a UX follow-up for its allowlist.
- The screens (the packet builder and review, the subject's packet viewer, the extract and the authority's queue) belong to Phase 12 S5 (UX, migration 2150).

## Still SOURCE_REQUIRED

- LEGAL_PRIVILEGE_RULE (AMB-118): until a CDF source is recorded, no item is cleared and no packet is released.
- PACKET_EVIDENCE_DOWNLOAD (AMB-171): view only until DEC-67 is answered.

## Production mapping

| Prototype                                                | Production                                                                                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| SHA-256 check in the Next.js BFF after reading the bytes | Integrity verification in the ASP.NET Core evidence service against Alibaba OSS, with KMS-signed manifests (PRODUCTION_SUBSTITUTION_REQUIRED) |
| Inline response for a packet item                        | A controlled viewer with watermarking and no save (PRODUCTION_SUBSTITUTION_REQUIRED)                                                          |
| SECURITY events in the audit ledger                      | Forwarded to SLS/SIEM                                                                                                                         |
| Notices by template code                                 | The CDF notification channel, same template codes                                                                                             |

## Requirements

DEC-F37, DEC-AMB-005, DEC-AMB-006; AMB-034, -106, -118, -159, -161, -164, -165, -169, -171, -191; P11-G4 (evidence half: T3-B2.3-112, T3-B2.3-144, S083, S118); CDF-212; protocol §18–§22, §24–§29, §39, §40, §68, §82, §83, §87.
