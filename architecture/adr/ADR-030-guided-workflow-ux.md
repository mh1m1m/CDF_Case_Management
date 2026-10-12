# ADR-030: Guided workflow UX and committee navigation

- **Status:** Proposed (2026-10-12). Linear CDF-200. Coordinated with the UX redesign (ADR-016) through the project coordinator.
- **Protocol:** §42; ADR-016.

## Decision

1. Primary areas: My Work, Intake, Cases, My Committees (Investigation, Grievance), Records, Oversight, Administration, Reporting. Each user sees at most about five, computed from effective seats and permissions, not raw roles.
2. `CDFWorkflowGuide` shows a proceeding's path, the current step, who acts next and why the user can or cannot act; every command shows a **consequence preview** (what changes, who is notified, what becomes irreversible) before submit.
3. Committee workspace: proceeding overview, meetings, conflict declarations, votes (secrecy rules), minutes review, recommendation builder, legal and authority status.
4. All text in `packages/i18n` (AR RTL / EN LTR), logical CSS properties, `data-testid` on interactive elements.
5. Implementation starts after UX S2 merges and is sequenced with the UX thread.

## Requirements

Rebase prompt §UX; ADR-016 D0.
