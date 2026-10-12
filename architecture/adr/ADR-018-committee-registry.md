# ADR-018: Committee registry and committee proceedings

- **Status:** Proposed (2026-10-12). Linear CDF-188, CDF-189.
- **Protocol:** §18–§21, §29, §87; owner Q&A Q21–Q40; ADR-014, ADR-016 (DEC-02).

## Context

Committee roles are global (`COMMITTEE_CHAIR`, `COMMITTEE_MEMBER`, `COMMITTEE_SECRETARY`), so holding the role is the only check and there is no notion of which committee, which seat, or which period. The owner model has two permanent committees with separate compositions and requires historic proceedings to keep the composition that decided them.

## Decision

1. New schema `committee`. `committee.committee` holds the two permanent committees (INVESTIGATION, GRIEVANCE); more can be added as data.
2. A **committee proceeding** (`committee.committee_proceeding`) is opened per referred case (a `case_mgmt.proceeding` of type COMMITTEE_INVESTIGATION or GRIEVANCE). On creation it copies the effective members (`proceeding_member`) and the effective rule set (`rule_snapshot`). Snapshots are never updated; a replacement is a new audited snapshot amendment row.
3. The committee may assign an investigator, team, member, external or technical investigator (Q31–Q34) as proceeding assignments; hearings, witnesses, technical analysis and legal opinion requests are meeting invitees or tasks.
4. Global committee roles stay as prerequisites; access comes from the snapshot (ADR-019, AUTHORIZATION_IMPACT).
5. Registry administration (create committee, appoint seats, set rules) needs `COMMITTEE_ADMIN`; PLATFORM_ADMIN can hold it without any content access.

## Consequences

Committee screens query by proceeding; the existing COMMITTEE grant scope remains for old cases. Audit: COMMITTEE_CREATED, COMMITTEE_MEMBER_APPOINTED, COMMITTEE_MEMBER_ENDED, COMMITTEE_PROCEEDING_OPENED, PROCEEDING_SNAPSHOT_AMENDED.

## Production mapping

Membership appointments come from CDF governance decisions; the prototype records appointment references as synthetic text.

## Requirements

Q21–Q40.
