# Connected Systems Baseline

CDF-CEOM initial activation report · 2026-10-07 · inspected from the Claude Code cloud session building this repository.

Classification: SYNTHETIC-DATA REFERENCE IMPLEMENTATION. No connector state below is inferred; anything that could not be inspected is `CONNECTOR_UNAVAILABLE`.

## Summary

| System       | Account connection | Reachable from this session | Status                                                                  |
| ------------ | ------------------ | --------------------------- | ----------------------------------------------------------------------- |
| GitHub       | Connected          | Yes                         | Target repository `prodya-dev/cdf-case-platform` **does not exist yet** |
| Linear       | Connected          | No (tools turned off here)  | CONNECTOR_UNAVAILABLE                                                   |
| Google Drive | Connected          | No (tools turned off here)  | CONNECTOR_UNAVAILABLE                                                   |
| Supabase     | Connected          | No (tools turned off here)  | CONNECTOR_UNAVAILABLE                                                   |
| Vercel       | Connected          | No (tools turned off here)  | CONNECTOR_UNAVAILABLE                                                   |
| Sentry       | Connected          | No (tools turned off here)  | CONNECTOR_UNAVAILABLE                                                   |
| Mixpanel     | Connected          | No (tools turned off here)  | CONNECTOR_UNAVAILABLE                                                   |
| Slack        | Connected          | No (tools turned off here)  | CONNECTOR_UNAVAILABLE                                                   |

"Connected" means the account has authorised the connector. Its tools are not enabled for this session, so none of its state was read.

## GitHub

- Repositories visible to the Claude GitHub app: `prodya-dev/Avatar`, `prodya-dev/AI-Story-Engine`. Neither is this project.
- The implementation exists locally in a git repository with four branches (`main` bootstrap, `phase-0/baseline-analysis`, `phase-1/engineering-foundation`, `phase-2-6/first-vertical-slice`). It has never been pushed, so **CI has never run remotely** and there is no GitHub Actions evidence yet.
- Remediation: the owner creates an empty private repository `prodya-dev/cdf-case-platform` and grants the Claude GitHub app access. Then the branches are pushed and PRs opened per CLAUDE.md §8 and §11.

## Linear (CONNECTOR_UNAVAILABLE)

Not inspected: existing initiative, projects, issues, duplicates and status model are unknown. **No backlog will be created until the workspace has been inspected and reconciled** (CEOM: inspect before mass ticket creation).

Planned reconciliation once reachable: map the existing structure onto EPIC 00–22 rather than recreating it. Then create issues at deliverable level for:

- the work already done (Phases 0–6 slice), recorded as IN_REVIEW against the open PRs;
- the open issues in `PROJECT_STATUS.md`;
- every `PRODUCTION_SUBSTITUTION_REQUIRED` row in `architecture/PRODUCTION_MAPPING.md`, labelled as such.

Branch and PR names then carry the Linear IDs.

## Google Drive (CONNECTOR_UNAVAILABLE)

Not searched. Current requirement sources are the documents attached to the project thread, summarised in `BASELINE_ANALYSIS.md`. Once reachable, search for the CDF architecture standards, the compliance workbook and the investigation forms. Record which version is authoritative, and surface any conflict with the repository.

## Supabase (CONNECTOR_UNAVAILABLE)

Not inspected. The repository builds and tests against local PostgreSQL 16 with a Supabase compatibility shim. A Supabase CLI job exists in CI but has not run. No hosted project has been confirmed. Once one is, compare the live schema and policies with `infrastructure/supabase/migrations/` and `infrastructure/supabase/policies/policy-snapshot.md`, and record EXPECTED / ACTUAL / DRIFT / CAUSE / REMEDIATION.

## Vercel (CONNECTOR_UNAVAILABLE)

Not inspected. Two projects are intended (`whistleblowing-web`, `investigation-web`), with separate environment variables. No deployment exists, and local builds pass. Previews will be verified per PR once a project is linked.

## Sentry (CONNECTOR_UNAVAILABLE)

Not inspected. The apps are not instrumented. Instrumentation would add a new third-party processor and dependency, so it needs a human decision (CLAUDE.md §8). If approved, it must use data-minimising scrubbing (no case content, reporter identity, tokens or identifiers).

## Mixpanel (CONNECTOR_UNAVAILABLE)

Not inspected. Nothing is instrumented. Instrumentation needs a human decision (a new processor) and an approved event catalogue. Proposed catalogue location: `compliance/mappings/analytics-events.md`.

## Slack (CONNECTOR_UNAVAILABLE)

Not inspected. Slack is not a system of record. Project communication currently happens in the Claude project thread.

## Misalignments found

1. The repository is local-only, so there is no GitHub system of record yet (blocking).
2. The Linear backlog state is unknown, so there is no work-item traceability for completed work.
3. No hosted Supabase or Vercel environment is confirmed, so the deployment-verification steps cannot run.
4. Sentry and Mixpanel are connected at account level but adopting them is undecided.
