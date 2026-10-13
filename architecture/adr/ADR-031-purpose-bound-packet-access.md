# ADR-031: Purpose-bound packet access

- **Status:** Proposed (2026-10-12). Linear CDF-201. Implemented in migration 1900 (draft, not merged). Security-sensitive.
- **Protocol:** §19–§22, §40, §87; ADR-014; ADR-016 DEC-02, DEC-09.

## Decision

1. A **packet** is an immutable snapshot of selected items made for one purpose (LEGAL_REVIEW, AUTHORITY_DECISION, GRIEVANCE_REVIEW, EXPORT, EMPLOYEE_NOTICE) and one audience. Packet readers reach only packet items, never case discovery.
2. Packet items reference findings, recommendation items, minutes extracts, decisions and documents. Evidence-version items are added only after UX S2 merges, so `authz.can_view_evidence` is not modified concurrently.
3. Protected identity is never a packet item. Classification is checked against the reader's clearance (DEC-01).
4. Packet creation and every packet read are audited (PACKET_CREATED, PACKET_VIEWED).

## Implementation notes (migration 1900)

- `decision.packet` and `decision.packet_item` are append-only snapshots. `authz.can_view_packet`: the proceeding's viewers, and for a LEGAL_REVIEW packet its assigned reviewer while they hold `LEGAL_OPINION_GIVE` and pass `authz.user_case_gate` (a later case conflict removes it at once).
- Packet items are recommendation items, findings, approved minutes and legal opinions only: no evidence (until UX S2 merges), no reporter data (N19). Every read through `api.open_packet` is audited.

- AGENT-09 W1: a proceeding participant who declared a conflict in any meeting of the proceeding loses the committee-side view of packages, items, scope, packets and opinions (`authz.has_meeting_conflict`, consistent with PRIOR_CONFLICT_DECLARED); the case team keeps its view. A conflicted secretary no longer manages packages.

## Requirements

DEC-02, DEC-09, Q75, Q99; negative tests N14, N19.
