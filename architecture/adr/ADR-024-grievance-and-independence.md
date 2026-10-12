# ADR-024: Grievance proceedings, employee defence and the independence firewall

- **Status:** Proposed (2026-10-12). Linear CDF-193, CDF-194.
- **Protocol:** §19–§22, §39, §87; owner Q&A Q37, Q45–Q46, Q90–Q96.

## Decision

1. A grievance is a GRIEVANCE proceeding inside the same case, LINKED to a decision or STANDALONE; a grievance with no prior case creates a case with `source_type = DIRECT_GRIEVANCE` (Q91).
2. Channels: EMPLOYEE_PORTAL, EMAIL, PHYSICAL, SECRETARY_ENTRY, BCP_IMPORT, OTHER, with the original received date preserved. The Grievance Committee Secretary receives it first (Q92) and records formal admissibility; the deciding party is configurable (SECRETARY / CHAIR / COMMITTEE) (Q93).
3. Window: 30 days by default, effective-dated in the GC rule set; late filings are flagged LATE_GRIEVANCE, not silently rejected (Q94).
4. Outcomes are combinable (UPHOLD, AMEND_SANCTION, CANCEL_SANCTION, REINVESTIGATE, REFER_TO_AUTHORITY, OTHER) (Q95). Reinvestigation can go to the same IC, a new team, a new or external investigator, or a technical investigation (Q96).
5. **Firewall:** anyone who held a voting seat in an IC proceeding of the case cannot hold a voting GC seat in that case's grievance; they may be invited as WITNESS / EXPERT / INFORMATION_PROVIDER (Q45–Q46). Enforced at snapshot creation and in `authz.can_participate_meeting`.
6. Employee notices are content-minimal; the subject submits defence via the employee portal or the Secretary uploads it; each subject has their own path in multi-subject cases (Q90).

## Requirements

Q37, Q45–Q46, Q90–Q96; negative test N9.
