# ADR-063: The Administration pages' capabilities, and three narrowings

- **Status:** Proposed (2026-10-18). Linear CDF-266, with CDF-259 and CDF-260. Migration
  `20261007002127_administration_capabilities.sql`, number and ADR allocated by the project coordinator
  (2026-10-18 19:50) with the conditions below. UX redesign Phase 12, step P12-8 (slice P12-8b). It merges after 2125
  (ADR-062) and before 2130.
- **Protocol:** §18 (RLS), §19 (authorization twice), §20 (security tests for an authorization change), §21
  (administration never implies case content), §87; ADR-016 D0; ADR-051 and its P12-8a amendment; UX-116.

## Context

P12-8a (PR #111) gave the Administration area its pages: six read-only registers, read in the caller's context under
row-level security (F2), and the business calendar's two forms. Before this migration:

1. No read said which administration command would accept the caller, so no page could offer a control. The
   calendar's two forms were the one exception (F1), because their commands check nothing but the caller's permission.
2. The pages a caller sees in the Administration area came from the application's permission check, not from the
   database (F3).
3. `api.appoint_sector_member` (1880) let a sector administrator appoint themselves to a sector, its head included
   (CDF-259, Security LOW). `api.appoint_committee_member` refuses this (`SELF_APPOINTMENT`, 1870), and no other
   appointment or grant allows it.
4. `api.set_notification_rule` (1920) ends the open rule of a key where the new one starts. A new rule starting at or
   before a later rule of the same key broke the constraint `effective_to > effective_from`, and the user saw
   "service unavailable" (CDF-260). `api.set_export_rule` and `api.set_corrective_action_policy` (2040) refuse this
   case (`LATER_RULE_EXISTS`, `LATER_POLICY_EXISTS`) under a lock on their key.
5. Three registers are updated in place and carry no version: the export purposes (DEC-F21), the invitee types
   (AMB-156, AMB-158), and a sanction type's grievance and severity rules (DEC-AMB-004, DEC-AMB-011). An
   administrator could overwrite a change they had never seen (F13).

The coordinator ruled on the P12-8 domain map's forks on 2026-10-18 (12:27):

- F3: the database gives the page list in P12-8b. F6 and F8: both are narrowed in P12-8b. F13: a fail-closed version
  check in P12-8b. F13 is a coordinator ruling that enforces an already-decided condition (no register is overwritten
  silently), with its negative tests in the same migration.
- F5: the seat, head and committee continuity-operator appointment forms wait, whatever DEC-12's scope is.
- F7: backdated or retroactive appointments and ends are an open question for the owner. There are no seat or position
  forms until the owner decides it, and the default stands meanwhile.
- F9: deactivation, annotation and the other COMMITTEE_ADMIN commands with no planned route go to a later slice.
- F10: the continuity-operator registry is built with 2160 (P12-10).

The allocation (19:50) set the conditions for this migration:

- It merges in number order, after 2125 and before 2130, on one PR.
- It stays a draft until AGENT-09 accepts the exact head.
- The negative tests for F6, F8 and F13 are in the same migration.
- It narrows only: nothing is widened before 2160.

## Decision

The database decides and the page explains (ADR-016 D0). The migration adds seven reads, replaces five commands
(two keep their signature, three take one more argument) and adds three columns. Each read is
`SECURITY DEFINER` with `search_path = ''`, `stable`, and granted to `authenticated` only. No table, policy or table
grant is added or changed, and nothing is deleted.

### 1. The caller's pages: `api.my_admin_views()`

The pages the caller may open, in this order. They are the pages `api.my_areas` (2045) counts for the ADMINISTRATION
area, in the order it uses to pick the area's default view:

1. users (USER_ADMIN or ROLE_ADMIN);
2. committees (COMMITTEE_ADMIN);
3. sectors (SECTOR_ADMIN);
4. notification rules (NOTIFICATION_ADMIN);
5. export policy (`authz.is_export_policy_admin()`: EXPORT_POLICY_ADMIN without approving exports, DEC-F24);
6. corrective-action policy (CORRECTIVE_ACTION_POLICY_ADMIN);
7. business calendar (BUSINESS_CALENDAR_ADMIN).

The area shows exactly when this list is not empty and opens on its first page. A user who is not active, or an
unknown one, gets an empty list. The list replaces the application's permission check for the sub-navigation (F3),
and each page still asks the database again before it shows anything.

### 2. One capability read per page

Each read is refused (FORBIDDEN) to whoever does not hold its page's permission, and to a user who is not active
(UNAUTHENTICATED), as its commands are. It returns the page's flags and, for a control that acts on one row, that
row's id with its flags. The registers themselves are not read here: the pages keep reading them in the caller's
context, under row-level security (F2), and match the flags to the rows by id.

| Read                                              | Flags                                                               | Commands it answers for                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `api.admin_calendar_capabilities`                 | `may_set_day`, `may_set_week_pattern`; per day: `may_withdraw`      | `set_business_calendar_day`, `set_business_week_pattern`, `withdraw_business_calendar_day` |
| `api.admin_committee_capabilities`                | per committee: `may_set_rule_set`, `may_revise_rule_set`            | `set_committee_rule_set`, `revise_committee_rule_set`                                      |
| `api.admin_sector_capabilities`                   | `may_create_sector`; per referral-approval delegation: `may_revoke` | `create_sector`, `revoke_referral_delegation`                                              |
| `api.admin_notification_rule_capabilities`        | `may_set_rule`                                                      | `set_notification_rule`                                                                    |
| `api.admin_export_policy_capabilities`            | `may_set_rule`, `may_add_purpose`; per purpose: `may_set`           | `set_export_rule`, `set_export_purpose`                                                    |
| `api.admin_corrective_action_policy_capabilities` | `may_set_policy`                                                    | `set_corrective_action_policy`                                                             |

The row states a command tells apart are these:

- **A calendar day:** it may be withdrawn unless it is already withdrawn (`CALENDAR_DAY_WITHDRAWN`) or past in Riyadh
  (`CALENDAR_DAY_PAST`).
- **A committee's rule set:** it may be revised only while a version is open (`NO_RULE_SET`).
- **A delegation:** it may be revoked unless it is revoked or ended (`DELEGATION_NOT_ACTIVE`). A delegation that has
  not started yet may be revoked. The read is the sector administrator's. A sector head who delegated still revokes
  from their own screen, as the command allows, but this page's read is not theirs.
- **An export purpose:** it may be set unless it is a legacy purpose (`LEGACY_PURPOSE`). Adding one needs only the
  caller check.

The users page has no read yet: it offers no form before P12-10.

### 3. How each flag is computed

The coordinator's rule of 2026-10-14 (11:53) applies, as for 2065, 2085, 2086, 2095 and 2096. Each flag runs its
command's checks, in the command's order, without taking a lock and without writing; every flag is a boolean, never
null.

Input checks stay the command's to answer at submit. These are the dates, codes, names and values, the start of a
version (`RULE_SET_SCHEDULED`, `PATTERN_SCHEDULED`, `LATER_RULE_EXISTS`, `LATER_POLICY_EXISTS`), a code or date already
taken, and the version read (§6).

A capability never widens a command: the command checks again when it runs.

### 4. F6: nobody appoints themselves to a sector (CDF-259)

`api.appoint_sector_member` keeps its signature, owner and grant. It refuses `CONFLICT:SELF_APPOINTMENT` when the
person appointed is the caller, as head or member, now or later. The check runs after the person is found, where
`api.appoint_committee_member` makes it. Nothing else changes. The sector page's appointment form stays hidden, as F5
and F7 require. CDF-259 is a Security issue, so it closes only on the owner's own word.

### 5. F8: a notification rule never starts before a later one of its key (CDF-260)

`api.set_notification_rule` keeps its signature, owner and grant. After its input checks it takes a transaction lock
on the key (layer, template, committee, channel), as `api.set_export_rule` does on its key. It then refuses
`CONFLICT:LATER_RULE_EXISTS` when a rule of the key, in force or scheduled, starts at or after the new one. A later
start still ends the open rule where the new one begins.

The lock serialises two administrators scheduling the same key. Without it, the second would not see the first's rule
and, once both were kept, would break the one open rule per key (`rule_open`). Nothing else changes.

### 6. F13: an in-place change fails closed on a stale version

`exchange.export_purpose`, `committee.invitee_type_rule` and `decision.sanction_catalogue` each gain
`row_version int not null default 1`. Every existing row starts at version 1.

`api.set_export_purpose`, `api.set_invitee_type_rule` and `api.set_sanction_rule` take the version the caller read as
their last argument (`p_expected_version`). Any other value is refused with `CONFLICT:STALE_VERSION`, a null included,
the code `api.update_case_details` uses (0700). Each success raises the version by one and records it in its audit
event's metadata. The old signatures are dropped, so no overload without the check remains, as 1810 did for
`api.create_case_from_report`.

- **An export purpose.** A code already in the catalogue needs the version read. A new code is added only with no
  version (null), and then starts at 1. The command takes a transaction lock on the code before it reads the
  catalogue. Without it, a second administrator adding the same code at once would find no row, and would then
  overwrite the purpose the first had added without having seen it. The checks run in this order: the caller, the
  inputs, the lock, a legacy purpose (whatever the version), the version, then OTHER's justification.
- **An invitee type.** The checks run in this order: the caller, the type, the version, then the inputs. The row is
  locked (`for update`) as before.
- **A sanction type.** The checks run in the same order: the caller, the type, the version, then the inputs. A refusal
  writes no `sanction_rule_change` row.

The pages read the version from the register they already show. Row-level security lets every active user read these
three registers, and no read here is needed. The pages that edit these rows come after this migration (§8); the
committee screens that read the invitee types and the sanction catalogue select their own columns and are unchanged.

### 7. What a capability tells

A capability tells nothing its command would not answer, and only to the holder of the page's permission. That holder
already sees every row the read names under row-level security:

- the calendar, the committees and the export purposes are visible to every signed-in user;
- the rule sets are visible to COMMITTEE_ADMIN (1870);
- the delegations are visible to SECTOR_ADMIN (1880).

The reads carry ids and booleans only: no case, no case-derived count, no name and no reason (§21).

### 8. Not in this change

- **The pages.** They come in the next change, with no migration, after this one merges:
  - the calendar's withdrawal;
  - creating a sector and revoking a delegation;
  - the notification rule form;
  - the export rule and purpose forms, offering narrowing values only (F4, F11);
  - the corrective-action policy form;
  - the committee rule-set forms.
- **Seat, head and position forms** (F5, F7). A sector's appointment form stays hidden, though F6 now refuses
  self-appointment.
- **Deactivation and annotation** (F9, P12-8c or later).
- **The 2160 panels** (authorities, export approvers and pool members; P12-8c).
- **The continuity-operator registry** (F10, P12-10).
- **User and role administration** (P12-10).

## Consequences

- The Administration area shows exactly the pages the database would let the caller use, in `api.my_areas`' order.
- Each page can offer a control exactly where its command would accept the caller now. A row's control follows the
  row's state.
- A sector administrator can no longer appoint themselves (CDF-259). A notification rule scheduled before a later rule
  of its key is refused with a code the page can explain, instead of a server error (CDF-260). An administrator who
  edits an export purpose, an invitee type or a sanction rule changes only the version they read (F13).
- Callers of the three F13 commands must now pass the version they read. The application calls none of them yet; the
  tests and fixtures that do pass the version from the register.
- A capability and its command can drift apart only if one of them changes without the other. The tests run the real
  command for every seed user and every row state they build, and fail when an answer differs.

## Where access is enforced, audit and tests

- **Enforced:** in the database. Each read refuses whoever its page's commands refuse on the caller check, and each
  command checks again when it runs. F6, F8 and F13 are enforced in the commands themselves.
- **Audit:** the reads write nothing; a test counts the ledger rows written while every caller reads. Each F13
  success records `row_version` in its event's metadata. A refusal writes nothing, as before.
- **Tests:** `tests/security/administration-capabilities-2127.spec.ts` (17 tests).
  - **The page list.** Every user in the directory gets exactly `api.my_areas`' Administration pages, in its order.
    A user who is not active gets none, and anonymous callers can call neither the list nor the reads.
  - **Each read against its commands.** For every seed user, each read answers exactly when its page's commands
    accept on the caller check (run and rolled back), and the page is listed exactly then. A user given one
    administration permission alone, for each of the eight, gets exactly that permission's page, its read and its
    commands, and nothing else.
  - **Each flag against its command.** Each flag equals its command's answer for each administrator and each row
    state: a calendar day ahead, today's, past or withdrawn; a committee with and without a version open to revision;
    a delegation in force, scheduled, revoked or ended; an export purpose in use or legacy. Every list names every
    row of its register, in the register's order.
  - **F6.** Self-appointment is refused as member or head, now or later, and writes nothing. Anyone else is still
    appointed.
  - **F8.** Starts at or before a later rule are refused, and nothing is written. A later start chains. Other keys are
    their own. When two administrators schedule one key at once, the second waits on the first's lock on that key
    (read from `pg_locks`) and schedules once the first is undone.
  - **F13.** For each of the three commands: a stale version, a null and a version ahead are refused, and nothing is
    written; a success raises the version and records it; the order of the checks is pinned. A new purpose is added
    only with no version, and a second administrator adding the same code waits on the lock on that code. When two
    administrators change one invitee type or sanction rule at once, the second waits on the row's lock before it
    reads the version, and changes the row once the first is undone.
  - **The functions.** Each read is stable, definer with an empty search path and authenticated only, and takes no
    lock or subtransaction and runs no command. Each F13 command has one signature, with the version last.

  Mutation check: 83 mutants of the new SQL, each with one check removed, widened, narrowed or moved, or one lock
  dropped, ran against the spec on a copy of the database. 81 fail a test. The first run left seven more standing:
  six permission checks in the page list and the reads, narrowed or pointed at another permission, which the seed
  could not tell apart because only the platform administrator holds those permissions, all together; and the
  invitee type's row lock, which nothing raced. The single-permission test and the row-lock test now pin them. The
  other two cannot change an answer, and stay as defence in depth:

  - the active-account check in `api.my_admin_views`: `authz.current_user_id()` is already null for an account that
    is not active, so every permission check is already false;
  - `api.set_export_purpose`'s row lock: the lock on the code already serialises every change of that code.

  Guards: `api-idor.spec.ts` (the six reads are administration commands with no object; `my_admin_views` is a global
  read), `audit-bypass.spec.ts` (the seven reads change nothing) and the policy snapshot. The existing callers of
  the three F13 commands in `export.spec.ts`, `grievance-defence.spec.ts`, `owner-decisions-meetings.spec.ts`,
  `my-committees-and-meeting-logistics.spec.ts`, `package-builder-and-invite-choices.spec.ts`, `audit-bypass.spec.ts`
  and `tests/support/grievance.ts` pass the version they read.

## Production mapping

Platform-independent SQL; it moves unchanged to RDS PostgreSQL. Administrators and their permissions come from the
CDF corporate IdP in production (PRODUCTION_SUBSTITUTION_REQUIRED, CDF-35).

## Requirements

- Phase 12 plan §4 (P12-8) and the P12-8 domain map §5.2 and §5.3.
- The coordinator's rulings of 2026-10-18 (12:27): F1, F2, F3, F5, F6, F7, F8, F9, F10 and F13. The allocation of
  2026-10-18 (19:50).
- ADR-016 D0; ADR-051 and its P12-8a amendment; UX-116.
- DEC-F02 (the business calendar); DEC-F21 and DEC-F24 (the export purposes and their administrator); AMB-156 and
  AMB-158 (the invitee types); DEC-AMB-004 and DEC-AMB-011 (the sanction rules); DEC-12 (dual control on grants;
  every comparable grant already refuses a self-grant, ADR-040).
- Linear CDF-266, CDF-259 and CDF-260.
