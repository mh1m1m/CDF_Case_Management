# Connected Systems Baseline

CDF-CEOM initial activation report · 2026-10-07 · Linear: [CDF-31](https://linear.app/cdfcasemanagement/issue/CDF-31)

Classification: SYNTHETIC-DATA REFERENCE IMPLEMENTATION. Every value below was read from the connected system on 2026-10-07. Anything that could not be read is `CONNECTOR_UNAVAILABLE` with the error; nothing is inferred.

## Summary

| System       | Reachable | What exists                                                      | Status for this platform                                  |
| ------------ | --------- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| GitHub       | Yes       | `mh1m1m/CDF_Case_Management`, PRs #1–#4 (all open drafts)        | System of record for code; CI running on PRs              |
| Linear       | Yes       | Workspace `CDF`, team `CDF` (key `CDF`)                          | Delivery hierarchy created (17 projects, EPIC 00–22)      |
| Google Drive | Yes       | CDF folder + architecture/compliance documents                   | Requirement sources identified                            |
| Supabase     | Yes       | Org `CDF`, one project, **empty** (0 migrations, 0 tables)       | Drift: whole schema not applied ([CDF-32])                |
| Vercel       | Partial   | One project `cdf` (predates the repo); details 403               | No project linked to this repo ([CDF-33])                 |
| Sentry       | Yes       | Org `cdf-xm` (EU region), **no projects**                        | Not instrumented; adoption needs a decision ([CDF-23])    |
| Mixpanel     | Partial   | Project `CDF` (id 4071134), EU-hosted                            | Events CONNECTOR_UNAVAILABLE (region mismatch) ([CDF-24]) |
| Slack        | Yes       | Workspace with `#all-cdf` (default channel, no project messages) | Communication only; no decisions to formalise             |

## GitHub

- Repository: https://github.com/mh1m1m/CDF_Case_Management (default branch `main`, bootstrap commit only).
- Open PRs. #1 → #2 → #3 are stacked and merge in that order; #5–#7 stack on #3 (Fady merges):

  | PR  | Branch                                   | Base                             | Linear                                                                               |
  | --- | ---------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
  | #1  | `phase-0/baseline-analysis`              | `main`                           | [CDF-28] (EPIC 00 [CDF-5])                                                           |
  | #2  | `phase-1/engineering-foundation`         | `phase-0/baseline-analysis`      | [CDF-29] (EPIC 01 [CDF-6])                                                           |
  | #3  | `phase-2-6/first-vertical-slice`         | `phase-1/engineering-foundation` | [CDF-30] (EPIC 04 [CDF-9]; related EPIC 02, 03, 05, 06, 07, 15)                      |
  | #4  | `claude/stitch-skill-xdoq19`             | `main`                           | None. Adds Google Stitch skills/MCP config; not part of the CEOM roadmap (see below) |
  | #5  | `docs/connected-systems-baseline-2knkfy` | `phase-2-6/first-vertical-slice` | [CDF-31] (this document)                                                             |
  | #6  | `claude/stitch-design-review-5w9w3x`     | `phase-2-6/first-vertical-slice` | Design review; findings tracked as [CDF-45] to [CDF-48] under EPIC 16 ([CDF-21])     |
  | #7  | `feature/CDF-44-evidence-custody`        | `phase-2-6/first-vertical-slice` | [CDF-44] (EPIC 08 [CDF-13])                                                          |

- The Linear GitHub integration is active: PR references in Linear issues resolve to the live PRs.
- The GraphQL API is not reachable from Claude cloud sessions; REST (`gh api`) works.

## Linear

Inspected before creating anything:

- Workspace `CDF` (https://linear.app/cdfcasemanagement), one team `CDF`, created 2026-10-07.
- Existing issues: CDF-1 to CDF-4, Linear's own onboarding issues. They are not project work and were left untouched.
- No projects, no initiatives, labels `Feature` / `Bug` / `Improvement` only. So there was nothing to deduplicate.
- Status model (used as-is): Backlog, Todo, In Progress, In Review, Done, Canceled, Duplicate. CEOM states map as BACKLOG → Backlog, READY → Todo, IN_PROGRESS → In Progress, IN_REVIEW / DEPLOYED_TO_PREVIEW / VALIDATING → In Review, BLOCKED → a `blocked by` relation, DONE → Done.

Created:

- Labels: `Epic`, `Security`, `PRODUCTION_SUBSTITUTION_REQUIRED`.
- 17 projects, one per CEOM workstream.
- 23 epics as parent issues, `EPIC NN` = `CDF-(NN+5)`:

  | Epic | Linear   | Project                          | State       |
  | ---- | -------- | -------------------------------- | ----------- |
  | 00   | [CDF-5]  | Platform Foundation              | In Review   |
  | 01   | [CDF-6]  | Platform Foundation              | In Review   |
  | 02   | [CDF-7]  | Platform Foundation              | In Progress |
  | 03   | [CDF-8]  | Identity & Access                | In Progress |
  | 04   | [CDF-9]  | Case Management                  | In Progress |
  | 05   | [CDF-10] | Whistleblowing                   | In Progress |
  | 06   | [CDF-11] | Privacy                          | In Progress |
  | 07   | [CDF-12] | Workflow                         | In Progress |
  | 08   | [CDF-13] | Evidence                         | Backlog     |
  | 09   | [CDF-14] | Investigation                    | Backlog     |
  | 10   | [CDF-15] | Investigation                    | Backlog     |
  | 11   | [CDF-16] | Committee & Decision             | Backlog     |
  | 12   | [CDF-17] | Corrective Action                | Backlog     |
  | 13   | [CDF-18] | Records & Retention              | Backlog     |
  | 14   | [CDF-19] | Reporting                        | Backlog     |
  | 15   | [CDF-20] | Security                         | In Progress |
  | 16   | [CDF-21] | QA                               | In Progress |
  | 17   | [CDF-22] | DevSecOps                        | In Progress |
  | 18   | [CDF-23] | Observability                    | Backlog     |
  | 19   | [CDF-24] | Observability                    | Backlog     |
  | 20   | [CDF-25] | Security                         | Backlog     |
  | 21   | [CDF-26] | Reference Implementation Release | In Progress |
  | 22   | [CDF-27] | Reference Implementation Release | Backlog     |

- Stories: [CDF-28] to [CDF-30] record Phases 0–6 against PRs #1–#3; [CDF-31] is this activation; [CDF-32] to [CDF-34] are the gaps below; [CDF-35] to [CDF-43] are the `PRODUCTION_SUBSTITUTION_REQUIRED` rows of `architecture/PRODUCTION_MAPPING.md` (the Sentry and Mixpanel rows are covered by EPIC 18 and 19). Created after activation: [CDF-44] (Phase 7 evidence slice, PR #7) and [CDF-45] to [CDF-48] (design-review findings, PR #6).
- Not created: the CEOM initiative "CDF Case Management & Investigation Platform". The Linear connector cannot create initiatives. The projects carry the platform name in their descriptions; the initiative can be added in the Linear UI and the projects attached to it.

## Google Drive

Searched the CDF folder and titles/text mentioning CDF. Requirement sources relevant to this platform (owner: Fady):

| Document                                                                                                                                             | Modified   | Used by      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------ |
| تقرير متطلبات خدمة الإبلاغ عن المخالفات (Whistleblowing) — docx, in folder `CDF`                                                                     | 2026-01-29 | EPIC 05      |
| architecture (Google Doc)                                                                                                                            | 2026-10-07 | EPIC 00, 21  |
| production-like prototype architecture GitHub + Supabase + Vercel + Claude Code (Google Doc)                                                         | 2026-10-07 | EPIC 00, 17  |
| SAUDI GOVERNMENT PLATFORM COMPLIANCE MASTER WORKBOOK ENGINE (Google Doc)                                                                             | 2026-10-07 | EPIC 21      |
| Mandate, Interaction Model, and Governing Standards of the Institutional Operational Oversight Office for the Cultural Development Fund (Google Doc) | 2026-01-18 | Context only |

None of these carries a version or approval marker, so the most recently modified copy is treated as current. Their contents were not copied into the repository. Unrelated personal files in the same Drive were ignored.

## Supabase

| Field          | Value                                                       |
| -------------- | ----------------------------------------------------------- |
| Organisation   | `CDF` (`rcnfafzoqddsdcrgpdmq`)                              |
| Project        | "CDF Case Management's Project", ref `blycdqjphsxvyiuoommv` |
| Region         | ap-northeast-1                                              |
| Postgres       | 17 (17.11.0.003), status ACTIVE_HEALTHY                     |
| Created        | 2026-10-07 07:09 UTC                                        |
| Migrations     | 0                                                           |
| Public tables  | 0                                                           |
| Security lints | none                                                        |

Drift record ([CDF-32]):

- EXPECTED_STATE: the 8 migrations in `infrastructure/supabase/migrations/` (`20261007000100_foundation` … `20261007000800_public_api`).
- ACTUAL_STATE: empty project.
- DRIFT: the entire schema, RLS and seed are absent.
- CAUSE: the project was created before any code existed; nothing has been applied.
- REMEDIATION: apply through the repository migrations after PR #3 merges, never by ad-hoc SQL; then run the DB security tests against it.

Only one project exists, where the CEOM expects `cdf-case-dev` and `cdf-case-demo`. Nothing was created in this activation: there is nothing to deploy to DEV until PR #3 merges, and a second project is Fady's call.

## Vercel

- Account `mohammedadelalsaleh-9344` (Hobby plan), default team `team_tJxfhTJObyoeBcCmY0SQnFHL` (scope `malsalehs-projects`). `list_teams` returns no teams.
- One project: `cdf` (`prj_Rur72UwjUtmEDpwyLhtWbM6f9iJG`), created 2026-01-28, last updated 2026-05-16. It predates this repository.
- CONNECTOR_UNAVAILABLE for project details and deployments: `403 forbidden — Not authorized: Trying to access resource under scope "malsalehs-projects"`. So its framework, Git link and deployments are unknown.
- No project builds `apps/whistleblowing-web` or `apps/investigation-web`, so there are no previews. The two intended projects were not created here: they need the connector's scope fixed and a decision on whether to reuse `cdf` ([CDF-33]).

## Sentry

- Organisation `cdf-xm` (https://cdf-xm.sentry.io, region `de.sentry.io`).
- Projects: none. Issues: none.
- The apps are not instrumented. Adding the SDK makes Sentry a new processor of runtime data, which needs Fady's decision ([CDF-23]). Scrubbing rules are recorded there.

## Mixpanel

- Project `CDF` (id `4071134`), default workspace "All Project Data".
- CONNECTOR_UNAVAILABLE for business context and events: `Regional access restriction: This project is hosted in a different geographic zone (eu.mixpanel.com) than the current MCP server (mcp.mixpanel.com)`. Reading events needs the EU Mixpanel connector (`mcp-eu.mixpanel.com`).
- The apps are not instrumented. Adoption and the event catalogue need Fady's decision ([CDF-24]).

## Slack

- One channel matches the project: `#all-cdf` (public, default channel, created 2026-10-07). It contains only the join message.
- No decisions to formalise. Nothing was posted.

## Misalignments and their issues

1. Supabase is empty, while the repository defines 8 migrations: [CDF-32].
2. No Vercel project builds this repository; the existing `cdf` project is unreadable (403): [CDF-33].
3. ~~The Supabase CLI compatibility job in CI had not been observed passing~~: it passed on this PR's head `8cd4a59` (Actions run 37605339626), closing [CDF-34].
4. Only one Supabase project exists, where the CEOM expects DEV and DEMO: decision in [CDF-32].
5. Sentry and Mixpanel are provisioned but adopting them is undecided; Mixpanel is unreadable from the current connector region: [CDF-23], [CDF-24].
6. PR #4 (Stitch skills and MCP config) has no Linear issue and is outside the CEOM roadmap. It should get an issue, or be closed, before merge.
7. Branch names before this activation do not carry Linear IDs. From now on they follow `feature|fix|security|refactor|docs/CDF-<n>-<desc>` (CLAUDE.md §11). Existing PR branches are not renamed; their Linear IDs are on the PRs as comments.
8. No Linear initiative exists, because the connector cannot create one (see Linear above).

[CDF-5]: https://linear.app/cdfcasemanagement/issue/CDF-5
[CDF-6]: https://linear.app/cdfcasemanagement/issue/CDF-6
[CDF-7]: https://linear.app/cdfcasemanagement/issue/CDF-7
[CDF-8]: https://linear.app/cdfcasemanagement/issue/CDF-8
[CDF-9]: https://linear.app/cdfcasemanagement/issue/CDF-9
[CDF-10]: https://linear.app/cdfcasemanagement/issue/CDF-10
[CDF-11]: https://linear.app/cdfcasemanagement/issue/CDF-11
[CDF-12]: https://linear.app/cdfcasemanagement/issue/CDF-12
[CDF-13]: https://linear.app/cdfcasemanagement/issue/CDF-13
[CDF-14]: https://linear.app/cdfcasemanagement/issue/CDF-14
[CDF-15]: https://linear.app/cdfcasemanagement/issue/CDF-15
[CDF-16]: https://linear.app/cdfcasemanagement/issue/CDF-16
[CDF-17]: https://linear.app/cdfcasemanagement/issue/CDF-17
[CDF-18]: https://linear.app/cdfcasemanagement/issue/CDF-18
[CDF-19]: https://linear.app/cdfcasemanagement/issue/CDF-19
[CDF-20]: https://linear.app/cdfcasemanagement/issue/CDF-20
[CDF-21]: https://linear.app/cdfcasemanagement/issue/CDF-21
[CDF-22]: https://linear.app/cdfcasemanagement/issue/CDF-22
[CDF-23]: https://linear.app/cdfcasemanagement/issue/CDF-23
[CDF-24]: https://linear.app/cdfcasemanagement/issue/CDF-24
[CDF-25]: https://linear.app/cdfcasemanagement/issue/CDF-25
[CDF-26]: https://linear.app/cdfcasemanagement/issue/CDF-26
[CDF-27]: https://linear.app/cdfcasemanagement/issue/CDF-27
[CDF-28]: https://linear.app/cdfcasemanagement/issue/CDF-28
[CDF-29]: https://linear.app/cdfcasemanagement/issue/CDF-29
[CDF-30]: https://linear.app/cdfcasemanagement/issue/CDF-30
[CDF-31]: https://linear.app/cdfcasemanagement/issue/CDF-31
[CDF-32]: https://linear.app/cdfcasemanagement/issue/CDF-32
[CDF-33]: https://linear.app/cdfcasemanagement/issue/CDF-33
[CDF-34]: https://linear.app/cdfcasemanagement/issue/CDF-34
[CDF-35]: https://linear.app/cdfcasemanagement/issue/CDF-35
[CDF-43]: https://linear.app/cdfcasemanagement/issue/CDF-43
[CDF-44]: https://linear.app/cdfcasemanagement/issue/CDF-44
[CDF-45]: https://linear.app/cdfcasemanagement/issue/CDF-45
[CDF-46]: https://linear.app/cdfcasemanagement/issue/CDF-46
[CDF-47]: https://linear.app/cdfcasemanagement/issue/CDF-47
[CDF-48]: https://linear.app/cdfcasemanagement/issue/CDF-48
