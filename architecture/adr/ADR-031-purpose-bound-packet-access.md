# ADR-031: Purpose-bound packet access

- **Status:** Proposed (2026-10-12). Linear CDF-201. Security-sensitive.
- **Protocol:** §19–§22, §40, §87; ADR-014; ADR-016 DEC-02, DEC-09.

## Decision

1. A **packet** is an immutable snapshot of selected items made for one purpose (LEGAL_REVIEW, AUTHORITY_DECISION, GRIEVANCE_REVIEW, EXPORT, EMPLOYEE_NOTICE) and one audience. Packet readers reach only packet items, never case discovery.
2. Packet items reference findings, recommendation items, minutes extracts, decisions and documents. Evidence-version items are added only after UX S2 merges, so `authz.can_view_evidence` is not modified concurrently.
3. Protected identity is never a packet item. Classification is checked against the reader's clearance (DEC-01).
4. Packet creation and every packet read are audited (PACKET_CREATED, PACKET_VIEWED).

## Requirements

DEC-02, DEC-09, Q75, Q99; negative tests N14, N19.
