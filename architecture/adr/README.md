# Architecture Decision Records

| ADR                                                                 | Title                                                                           | Status   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------- |
| [ADR-001](ADR-001-supabase-for-prototype.md)                        | Supabase as prototype infrastructure                                            | Accepted |
| [ADR-002](ADR-002-separate-public-and-internal-apps.md)             | Separate public and internal applications                                       | Accepted |
| [ADR-003](ADR-003-postgresql-rls-security-model.md)                 | PostgreSQL / RLS security model and command-only writes                         | Accepted |
| [ADR-004](ADR-004-whistleblower-identity-vault.md)                  | Whistleblower identity vault                                                    | Accepted |
| [ADR-005](ADR-005-append-only-audit-ledger.md)                      | Append-only, hash-chained audit ledger                                          | Accepted |
| [ADR-006](ADR-006-evidence-storage-abstraction.md)                  | Evidence storage abstraction                                                    | Accepted |
| [ADR-007](ADR-007-workflow-engine.md)                               | Data-driven workflow engine                                                     | Accepted |
| [ADR-008](ADR-008-production-portability.md)                        | Production portability strategy                                                 | Accepted |
| [ADR-009](ADR-009-monorepo-and-adapter-packages.md)                 | Monorepo layout and adapter package                                             | Accepted |
| [ADR-010](ADR-010-identity-and-sessions.md)                         | Identity providers and session handling                                         | Accepted |
| [ADR-011](ADR-011-forms-engine.md)                                  | Data-driven forms engine for the WB-FRM catalogue                               | Accepted |
| [ADR-012](ADR-012-interviews.md)                                    | Interviews domain                                                               | Accepted |
| [ADR-013](ADR-013-records-retention-legal-hold.md)                  | Records, retention, legal hold and disposition                                  | Proposed |
| [ADR-014](ADR-014-purpose-bound-records-legal-authorization.md)     | Purpose-bound records and legal authorization model                             | Proposed |
| [ADR-015](ADR-015-reporter-attachments.md)                          | Reporter attachments via public_api                                             | Proposed |
| [ADR-016](ADR-016-ux-target-and-access-decisions.md)                | UX target architecture and approved access decisions                            | Accepted |
| [ADR-017](ADR-017-case-and-proceeding-model.md)                     | Case and Proceeding model, intake paths, direct referral and preliminary review | Proposed |
| [ADR-018](ADR-018-committee-registry.md)                            | Committee registry and committee proceedings                                    | Proposed |
| [ADR-019](ADR-019-committee-membership-effective-dating.md)         | Committee membership, seats and effective dating                                | Proposed |
| [ADR-020](ADR-020-meetings-voting-quorum-minutes.md)                | Meetings, conflict of interest, quorum, voting and minutes                      | Proposed |
| [ADR-021](ADR-021-recommendation-packages-sanctions.md)             | Recommendation packages and the sanction catalogue                              | Proposed |
| [ADR-022](ADR-022-legal-review-packets.md)                          | Legal review packets                                                            | Proposed |
| [ADR-023](ADR-023-competent-authority-external-decision.md)         | Competent authority and externally made decisions                               | Proposed |
| [ADR-024](ADR-024-grievance-and-independence.md)                    | Grievance proceedings, employee defence and the independence firewall           | Proposed |
| [ADR-025](ADR-025-notification-engine.md)                           | Notification engine                                                             | Proposed |
| [ADR-026](ADR-026-export-builder-and-email.md)                      | Export Builder and external email                                               | Proposed |
| [ADR-027](ADR-027-bcp-workbook-and-import.md)                       | Business continuity workbook and governed import                                | Proposed |
| [ADR-028](ADR-028-form-catalogue-rationalization.md)                | Form catalogue rationalization                                                  | Proposed |
| [ADR-029](ADR-029-status-catalogue-rationalization.md)              | Status catalogue rationalization                                                | Proposed |
| [ADR-030](ADR-030-guided-workflow-ux.md)                            | Guided workflow UX and committee navigation                                     | Proposed |
| [ADR-031](ADR-031-purpose-bound-packet-access.md)                   | Purpose-bound packet access                                                     | Proposed |
| [ADR-032](ADR-032-export-approval-binding.md)                       | Export approval rules, preview binding and generation                           | Proposed |
| [ADR-033](ADR-033-corrective-action-tracking.md)                    | Corrective-action tracking                                                      | Proposed |
| [ADR-034](ADR-034-bcp-import-pipeline.md)                           | Continuity workbook template BCP-1 and the governed import pipeline             | Proposed |
| [ADR-035](ADR-035-form-status-catalogue-reference-data.md)          | The form and status catalogue as grounded reference data                        | Proposed |
| [ADR-036](ADR-036-preliminary-closure-outcomes.md)                  | Closure outcomes of the preliminary review                                      | Proposed |
| [ADR-037](ADR-037-employee-notice-kinds.md)                         | Kinds of employee notice; the decision notice starts the grievance window       | Proposed |
| [ADR-038](ADR-038-meeting-excuses-raised-conflicts.md)              | Excused attendance; conflicts raised by another meeting participant             | Proposed |
| [ADR-039](ADR-039-meeting-witness-exclusion.md)                     | Excluding a witness from a committee meeting                                    | Proposed |
| [ADR-040](ADR-040-owner-finalization-decisions.md)                  | Applying the owner's Finalization Set and ambiguity decisions                   | Proposed |
| [ADR-041](ADR-041-evidence-half-and-defence-packet.md)              | The evidence half of P11-G4, the Defence Packet and the prior-sanctions extract | Proposed |
| [ADR-042](ADR-042-case-closure-reopening-and-package-read-model.md) | Case closure, outcome and reopening; the package-building read model            | Proposed |
| [ADR-043](ADR-043-preliminary-corrective-action.md)                 | Preliminary corrective action; closure fails closed with no authority in force  | Proposed |
| [ADR-044](ADR-044-case-conflict-purpose-suspension.md)              | A conflict raised on the case; prior investigators do not judge it              | Proposed |
| [ADR-045](ADR-045-case-structure-corrections.md)                    | Case structure and corrections without rewriting a record                       | Proposed |
| [ADR-046](ADR-046-people-and-access.md)                             | People and access without widening anyone's reach                               | Proposed |
| [ADR-047](ADR-047-continuity-committee-workbook.md)                 | The committee continuity workbook and restore notices (migration 2110)          | Proposed |
| [ADR-048](ADR-048-paper-ballots.md)                                 | Paper ballots of a committee meeting held offline (migration 2120)              | Proposed |
| [ADR-051](ADR-051-areas-and-my-work-phase-12.md)                    | Areas and My Work for Phase 12                                                  | Proposed |
| [ADR-054](ADR-054-meeting-screen-capabilities.md)                   | The meeting screen's capabilities                                               | Proposed |
| [ADR-055](ADR-055-my-committees-and-meeting-logistics.md)           | My Committees and the meeting's logistics                                       | Proposed |
| [ADR-056](ADR-056-package-builder-and-invite-choices.md)            | The recommendation package builder and the meeting's invite list                | Proposed |
| [ADR-057](ADR-057-legal-review-and-authority-read-models.md)        | Legal review and the authority's decision: read models                          | Proposed |
| [ADR-058](ADR-058-superseded-decision-corrective-actions.md)        | Corrective actions under a superseded decision: read models                     | Proposed |
| [ADR-059](ADR-059-superseded-allegation-notice-rule.md)             | A superseded allegation needs no defence notice at adoption                     | Proposed |
| [ADR-061](ADR-061-committee-workbook-official-record.md)            | The committee workbook's official record and attestation (migration 2115)       | Proposed |
| [ADR-062](ADR-062-paper-ballot-release-before-supersession.md)      | A bound paper ballot is superseded only after a release (migration 2125)        | Proposed |
| [ADR-063](ADR-063-administration-capabilities.md)                   | The Administration pages' capabilities and three narrowings (migration 2127)    | Proposed |
| [ADR-064](ADR-064-seat-and-position-end-references.md)              | Seat and position end references and capability flags (migration 2128)          | Proposed |

**Decision IDs DEC-61 and DEC-62 (CON-011).** Each ID names two different things. In ADR-018 §7 and ADR-022 they are owner card decisions: DEC-61 (owner card, restricted referral) and DEC-62 (owner card, restricted legal review). In the UX audit register O17 §17.7, the source of ADR-016, they are audit items, cited here as UX DEC-61 (the Stitch project) and UX DEC-62 (new case entities).

Template: Context · Decision · Consequences · Production mapping · Requirements.
