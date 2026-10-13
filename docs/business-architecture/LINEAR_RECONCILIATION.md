# Linear Reconciliation

Linear is the backlog system of record (CDF-CEOM). Project: **CDF Business Architecture Rebase** (P-CDF-19). Existing issues were reconciled first; no micro-tickets were created. Slices inside an epic are tracked in the epic until a PR needs its own issue.

## Epics created

| Epic                                        | Linear  | Phase | Related existing issues (kept, not duplicated)                       |
| ------------------------------------------- | ------- | ----- | -------------------------------------------------------------------- |
| BAR-01 Core Domain                          | CDF-186 | 2     | CDF-7 (EPIC 02), CDF-15 (EPIC 10 Findings), CDF-156 (Finding tab UI) |
| BAR-02 Direct Referral + preliminary review | CDF-187 | 4     | CDF-110 (baseline Referrals keep/defer/drop)                         |
| BAR-03 Committee Registry                   | CDF-188 | 2–3   | CDF-16 (EPIC 11 Committee & Decisions)                               |
| BAR-04 Investigation Committee              | CDF-189 | 5     | CDF-16, CDF-95 (UXR-08)                                              |
| BAR-05 Meeting & Voting                     | CDF-190 | 5     | CDF-158 (meetings and agenda UI)                                     |
| BAR-06 Recommendations & Decisions          | CDF-191 | 6     | CDF-155, CDF-159, CDF-160, CDF-17 (EPIC 12)                          |
| BAR-07 Legal Review                         | CDF-192 | 6     | CDF-157 (review packet security)                                     |
| BAR-08 Grievance                            | CDF-193 | 7     | —                                                                    |
| BAR-09 Employee Portal                      | CDF-194 | 7     | CDF-161 (subject-facing channel UI)                                  |
| BAR-10 Notifications                        | CDF-195 | 8     | CDF-90 (UXR-03 My Work & notifications)                              |
| BAR-11 Export                               | CDF-196 | 9     | CDF-19 (EPIC 14), CDF-139 (generated documents)                      |
| BAR-12 Business Continuity                  | CDF-197 | 10    | —                                                                    |
| BAR-13 Form Rationalization                 | CDF-198 | 11    | CDF-92 (UXR-05 forms), CDF-136                                       |
| BAR-14 Status Rationalization               | CDF-199 | 11    | CDF-12 (EPIC 07 workflow)                                            |
| BAR-15 UX Rebase                            | CDF-200 | 12    | CDF-95, CDF-89 (UXR-02 navigation), CDF-135 (decision panel)         |
| BAR-16 Security & Testing                   | CDF-201 | all   | CDF-25 (EPIC 20), CDF-99 (UXR-12 purpose-bound)                      |
| Docs PR (phases 0–1)                        | CDF-202 | 0–1   | —                                                                    |

## Division of ownership

- **Rebase epics own the data model, commands, authorization and tests.** UX epics (CDF-95 children, CDF-161) keep the screens and call the rebase commands.
- The UX redesign thread keeps S2 (evidence, reporter conversation, history/roster, retention queue). The rebase does not touch those functions until S2 merges.

## Conflicts surfaced (not silently resolved)

| Item                                              | Conflict                                                                                                                         | Resolution used                                                                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| CDF-159 "deciders record their own decisions"     | Owner Q80–Q82: the authority may decide outside the platform; the Secretary records it with a source document, no maker-checker. | Both paths supported; Secretary recording is the default.                                                                                             |
| CDF-155 "decision: lifecycle model and authority" | Answered by owner Q71–Q85.                                                                                                       | ADR-023; CDF-155 can close when ADR-023 is accepted.                                                                                                  |
| CDF-111 (procedure doc «إجراء التحقيق» conflict)  | Earlier conflict entry; rebase follows the owner Q&A where they differ.                                                          | Noted; no change to CDF-111.                                                                                                                          |
| Status count                                      | Brief says 140; the Drive catalogue has 150.                                                                                     | Both lists rationalized (migration 1970, ADR-035); 10 codes mean different statuses in the two lists, which list is authoritative is SOURCE_REQUIRED. |
| Form count                                        | Brief says 274 forms in 12 tracks; the owner supplied the catalogue in the project thread on 2026-10-12.                         | All 462 (169 + 19 + 274) rationalized in Phase 11 (migration 1970, ADR-035).                                                                          |
