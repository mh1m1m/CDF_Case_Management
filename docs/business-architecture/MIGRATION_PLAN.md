# Migration Plan

> Git migrations are authoritative (§12). Numbers are allocated by the project coordinator, one at a time, above `main`'s highest. In flight at the time of writing: 1820 (UX S1, PR #52), 1830–1860 (UX S2). Numbers below marked `TBA` are requested, not yet allocated, and are never reused or renumbered once allocated.

## 1. Rules

- **Additive only.** No DROP, no column type narrowing, no data deletion. `case_type`, CDF_CASE_V1, global committee roles and COMMITTEE grants stay working. Removal needs a human decision with backup, rollback, mapping and test plan (§88).
- **No S2 overlap.** None of these migrations redefine `api.my_work_items`, evidence predicates/commands, reporter conversation commands, `api.case_history`/roster or `assign_retention_class` while the S2 PR is open.
- Every migration: RLS on every new table, SELECT-only policies, no write grants, `SECURITY DEFINER` + `SET search_path = ''`, audit event per command, coverage lists (`api-idor`, `audit-bypass`, `rls-coverage`, `mirrors`, `fk-indexes`) and `pnpm db:policies` snapshot in the same PR.
- New schemas (`committee`, `decision`, `notify`, `exchange`) are added to `APP_SCHEMAS` in `rls-coverage.spec.ts` and to `scripts/db/policy-snapshot.mjs`.
- Each PR runs locally: `pnpm db:reset && pnpm test:db`, `pnpm lint`, `pnpm typecheck`, `pnpm test`.

## 2. Sequence and dependencies

| Step | Number           | Content                                                                                                                                                                                                                                                                                                                               | Depends on                      | Phase | Risk                                                                           |
| ---- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----- | ------------------------------------------------------------------------------ |
| M1   | 1870 (requested) | `case_record.source_type` (+ backfill WHISTLEBLOWING), `case_mgmt.proceeding`, `case_subject`, allegation extensions, `finding`, `evidence_link`; schema `committee` with committee, membership, rule_set (seeded OWNER_DEFAULT), delegation, committee_proceeding + member snapshot; registry and proceeding commands; audit events. | main ≥ 1810                     | 2     | Backfill on `case_record` (additive column with default).                      |
| M2   | 1880 (requested) | `authz` committee predicates, RLS policies on committee tables, registry admin permission, negative tests N1–N3, N13, N20.                                                                                                                                                                                                            | M1                              | 3     | Access-model change: AGENT-09 review.                                          |
| M3   | TBA              | Meetings, agenda, invitees, eligibility snapshot, per-meeting COI, attendance, vote items, votes, casting vote, minutes, minutes review, deemed approval; `MeetingProvider` port.                                                                                                                                                     | M2                              | 5     | Security-sensitive (votes).                                                    |
| M4   | TBA              | Sectors, sector membership/delegation, `intake.referral` + events, referral commands, case creation from referral; roles SECTOR_HEAD, COMPLIANCE_SECTION_MANAGER, GRC_SECTOR_HEAD; preliminary recommendation + routing config.                                                                                                       | M1 (M2 for secretary predicate) | 4     | New roles: AGENT-09 review.                                                    |
| M5   | TBA              | Schema `decision`: recommendation package/items/junctions, sanction catalogue, authority type/rules, legal review request/items/opinion, authority decision, corrective action.                                                                                                                                                       | M3                              | 6     | Packets: purpose-bound review.                                                 |
| M6   | TBA              | Grievance, firewall predicate, employee notice, defence submission, EMPLOYEE role surface.                                                                                                                                                                                                                                            | M3, M5                          | 7     |                                                                                |
| M7   | TBA              | Schema `notify`: rules (4 layers), preferences, outbox; `NotificationSender` port.                                                                                                                                                                                                                                                    | M3                              | 8     | New external channel (email adapter is a stub; real SMTP is a human decision). |
| M8   | TBA              | Schema `exchange`: export request/items/recipients/approvals, preview hash.                                                                                                                                                                                                                                                           | M5                              | 9     | External email = human decision on provider.                                   |
| M9   | TBA              | BCP workbook registry, import staging rows, provenance columns on imported tables, `config.legacy_status_map`.                                                                                                                                                                                                                        | M1–M6                           | 10    | Bulk import: approval gate.                                                    |
| M10  | TBA              | Form/status catalogue reference rows (form module map, status dimension vocabularies).                                                                                                                                                                                                                                                | M1                              | 11    | Reference data only.                                                           |

```
1810(main) ─▶ M1 ─▶ M2 ─▶ M3 ─┬─▶ M5 ─┬─▶ M6
                  └─▶ M4      ├─▶ M7  └─▶ M8
                              └────────────▶ M9 ─▶ M10 (M10 may land earlier)
```

## 3. Compatibility

| Existing element                                            | Treatment                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `case_record.case_type`                                     | Kept. `source_type` is the new intake path; both shown until a cutover decision.                              |
| CDF_CASE_V1 workflow                                        | Kept for existing and whistleblowing cases; proceeding records attach alongside.                              |
| `COMMITTEE` workflow state / grant                          | Kept. New committee screens use proceedings; existing grants not revoked.                                     |
| `COMMITTEE_QUORUM`, `FINAL_DISCIPLINARY_AUTHORITY` settings | Read-only; superseded by `committee.rule_set` and `decision.action_authority_rule`. Marked DEPRECATE in docs. |
| WB-FRM forms                                                | Kept; map to modules per `FORM_CATALOGUE_RATIONALIZATION.md`.                                                 |

## 4. Rollback

Each migration is additive, so rollback in DEV is a forward migration that disables new commands (revoke EXECUTE) without dropping data. Local and CI rebuild from scratch via `pnpm db:reset`. Hosted DEV apply is done by the connected-systems thread after merge, never from this branch.

## 5. Seed data

Synthetic only, in `infrastructure/supabase/seed/`: two committees (Investigation, Grievance) with members _Chair Alpha_, _Secretary Beta_, _Member Gamma_ …, one sector _Sector Delta_ with head _Head Epsilon_, demo case `CDF-DEMO-2026-0001`. No real names, sanctions or minutes.
