# Authorization Impact

> Builds on ADR-003 (RLS + command-only writes), ADR-014 (purpose-bound access) and ADR-016 (DEC-01..37). Authorization is enforced twice: `@cdf/authorization` pre-check and the database (`authz.*` + RLS).

## 1. Principles

1. **Seat, not role.** Committee access = user + committee + seat + effective period + proceeding. Global roles `COMMITTEE_*` are prerequisites only (CDF-73 option D: functional authority never implies case discovery).
2. **Snapshots decide.** A committee proceeding's member snapshot, not today's membership, decides who participates in that proceeding. Later membership changes affect new proceedings only; replacements go through an audited snapshot amendment command.
3. **Conflict excludes.** A per-meeting CONFLICT_DECLARED or PENDING declaration blocks attendance, deliberation and voting; the member is excluded from quorum. Enforced in commands and in `authz.can_participate_meeting`.
4. **Grievance firewall.** `authz.participated_in_investigation_committee(user, case)` is true for anyone who held a voting seat in an IC proceeding of the case; such users cannot hold a voting GC seat on that case's grievance (may be invited as WITNESS / EXPERT / INFORMATION_PROVIDER).
5. **Packets are purpose-bound.** Legal reviewers, authority recorders and export recipients see only snapshot packet items selected for them, never the full case (DEC-02, DEC-09).
6. **No content for admins.** `PLATFORM_ADMIN` / `DB_ADMIN` administer committee registry and rule sets but get no case, meeting, vote or minutes content.
7. **Protected identity** is never in a packet, minutes snapshot, export or notification.
8. **Vote secrecy.** Votes have no SELECT grant; `api.vote_item_status` returns who voted and when before close, choices only after close.

## 2. New `authz.*` predicates

| Function                                                          | True when                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `authz.committee_seat(committee_id, at)`                          | caller's effective seat in committee at instant (null if none).                 |
| `authz.is_committee_secretary(committee_id)`                      | effective SECRETARY, or ALTERNATE_SECRETARY, or active delegation to SECRETARY. |
| `authz.is_proceeding_member(committee_proceeding_id)`             | caller is in the proceeding's member snapshot (any seat).                       |
| `authz.can_view_committee_proceeding(committee_proceeding_id)`    | proceeding member, or committee secretary.                                      |
| `authz.can_participate_meeting(meeting_id)`                       | proceeding member, voting seat, conflict NO_CONFLICT for that meeting.          |
| `authz.participated_in_investigation_committee(user_id, case_id)` | user held a voting seat in an IC proceeding on the case.                        |
| `authz.is_sector_head_or_delegate(sector_id, scope)`              | effective HEAD, or effective delegation with that scope.                        |
| `authz.can_view_referral(referral_id)`                            | preparer, sector head/delegate of its sector, IC secretary.                     |
| `authz.can_view_legal_packet(request_id)`                         | assigned legal reviewer of that request, committee secretary.                   |

All are `SECURITY DEFINER`, `STABLE`, `SET search_path = ''`, added to the helper allow-list in `audit-bypass.spec.ts` and to `api-idor.spec.ts` probes.

## 3. Impact on existing predicates

| Existing                  | Change                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `authz.can_view_case`     | Unchanged in Phase 3. Committee members reach committee screens through proceeding predicates, not full case view (DEC-02). |
| `authz.has_active_grant`  | Unchanged (scope fix is DEC-02 work already tracked in UX stages).                                                          |
| `authz.can_view_evidence` | **Not touched** until S2 merges. Packet-based evidence access is ADR-031 follow-up.                                         |
| COMMITTEE grant scope     | Superseded for new proceedings by membership snapshot; existing grants keep working.                                        |

## 4. RLS

Every new table: RLS enabled, default deny, SELECT policies only, using the predicates above; no INSERT/UPDATE/DELETE grants to `authenticated` / `anon`. Votes, protected identity links and BCP staging rows: no SELECT policy at all (definer reads only).

## 5. Negative tests (mandatory)

| #   | Test                                                                                                  | Layer |
| --- | ----------------------------------------------------------------------------------------------------- | ----- |
| N1  | Global COMMITTEE_MEMBER without seat cannot see committee proceedings, meetings, votes, minutes.      | DB    |
| N2  | Member of IC cannot see GC proceedings and vice versa.                                                | DB    |
| N3  | Expired membership (effective_to in past) loses access to new proceedings; snapshot stays historical. | DB    |
| N4  | Conflicted member cannot attend, vote, or count toward quorum.                                        | DB    |
| N5  | PENDING conflict blocks voting.                                                                       | DB    |
| N6  | Secretary cannot record APPROVE / REJECT for another member.                                          | DB    |
| N7  | Votes are not selectable directly; choices hidden before close.                                       | DB    |
| N8  | Casting vote rejected when not a tie or rule disables it.                                             | DB    |
| N9  | IC voting member cannot be a voting GC member on the same case.                                       | DB    |
| N10 | Preliminary reviewer cannot be preparer; approver must be GRC Sector Head.                            | DB    |
| N11 | Sector delegate outside window cannot approve a referral.                                             | DB    |
| N12 | Non-secretary cannot accept / reject a referral.                                                      | DB    |
| N13 | PLATFORM_ADMIN can manage registry but cannot read meetings, votes, minutes.                          | DB    |
| N14 | Legal reviewer sees only selected packet items.                                                       | DB    |
| N15 | Authority decision cannot become effective without a source document.                                 | DB    |
| N16 | Export of an item the requester cannot view is refused; external email needs justification.           | DB    |
| N17 | BCP import cannot overwrite provenance or bypass approval.                                            | DB    |
| N18 | Notifications contain no case content (template code + IDs only).                                     | unit  |
| N19 | Protected identity never appears in packets, minutes, exports.                                        | DB    |
| N20 | Anonymous / anon role cannot call any new `api.*` command.                                            | DB    |
