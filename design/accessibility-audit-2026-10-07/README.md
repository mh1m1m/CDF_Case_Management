# Accessibility audit: both apps, WCAG 2.1 AA (2026-10-07)

**Scope.** PR #7 head `54786e4` (branch `feature/CDF-44-evidence-custody`), run locally with PostgreSQL 16, the CI environment and synthetic seed data. 19 screen states (8 portal, 11 internal, including validation errors, receipt, follow-up status, triage, create case, case detail with evidence, administrator home) × Arabic RTL and English LTR × desktop 1280 px and phone 390 px = 76 runs.

**Result.** 4 serious, 5 moderate and 5 minor findings, filed as seven Linear stories under CDF-21 (CDF-52 to CDF-58). Three earlier design-review stories (CDF-46, CDF-47, CDF-48) already cover the colour-contrast, language-of-parts and tracker-layout failures and are linked, not repeated. The existing a11y test passes because it only fails on axe `serious`/`critical` and none of these defects is an axe serious rule.

## Fix first

1. **A11Y-02 Case page reflow** (CDF-53): a one-line `min-w-0` fix that stops the case page scrolling sideways on phones.
2. **A11Y-01 Arabic card ids** (CDF-52): one change in `CDFCard` fixes the Arabic section names on the case and intake pages.
3. **A11Y-03 Portal follow-up focus** (CDF-54): public portal, two `focus()` calls, same pattern as the receipt.
4. **A11Y-04 Tracker states** (CDF-55): visually hidden status text plus a check mark, in one shared component.

## Findings

| ID      | Severity | Finding                                                                          | WCAG                                                    | Screen                                                                                                       | Language | Story  |
| ------- | -------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------- | ------ |
| A11Y-01 | Serious  | Every card on the case and intake pages is announced as the first card in Arabic | 1.3.1 Info and Relationships; 4.1.2 Name, Role, Value   | Case detail (7 sections), intake report detail (triage and create-case cards)                                | Arabic   | CDF-52 |
| A11Y-02 | Serious  | Case page scrolls sideways on phones and at 400% zoom                            | 1.4.10 Reflow                                           | Case detail                                                                                                  | Both     | CDF-53 |
| A11Y-03 | Serious  | Opening a report on the portal follow-up page drops keyboard focus               | 2.4.3 Focus Order; 4.1.3 Status Messages                | Portal follow-up: after Check status, and after Sign out of follow-up                                        | Both     | CDF-54 |
| A11Y-04 | Serious  | Workflow tracker shows which steps are done only by colour                       | 1.4.1 Use of Color; 1.3.1 Info and Relationships        | Case detail                                                                                                  | Both     | CDF-55 |
| A11Y-05 | Moderate | Every page in each app has the same title                                        | 2.4.2 Page Titled                                       | All screens                                                                                                  | Both     | CDF-56 |
| A11Y-06 | Moderate | Session ends after 30 idle minutes with no warning                               | 2.2.1 Timing Adjustable                                 | Investigation app, all forms                                                                                 | Both     | CDF-57 |
| A11Y-07 | Moderate | Internal forms do not say which fields are required                              | 3.3.2 Labels or Instructions; 1.3.1                     | Evidence upload, assign person, update details, conflict declaration; portal report form (programmatic only) | Both     | CDF-58 |
| A11Y-08 | Moderate | Server-side errors in internal forms are not tied to their fields                | 3.3.1 Error Identification; 3.3.3 Error Suggestion      | Every `ActionForm`: triage, create case, assign, transitions, evidence, conflict                             | Both     | CDF-58 |
| A11Y-09 | Moderate | Heading and landmark outline has gaps                                            | 1.3.1 Info and Relationships; 2.4.6 Headings and Labels | Case detail, admin home, all pages                                                                           | Both     | CDF-52 |
| A11Y-10 | Minor    | Repeated controls share one name                                                 | 2.4.6 Headings and Labels (advisory)                    | Case detail, portal receipt                                                                                  | Both     | CDF-53 |
| A11Y-11 | Minor    | Login error is announced twice                                                   | 4.1.3 Status Messages (advisory)                        | Login                                                                                                        | Both     | CDF-54 |
| A11Y-12 | Minor    | Reporter reference hint lives only in a title tooltip                            | 1.3.1 / 3.3.2 (advisory)                                | Case detail                                                                                                  | Both     | CDF-53 |
| A11Y-13 | Minor    | Date fields show the browser's mm/dd/yyyy format on Arabic pages                 | 3.3.2 Labels or Instructions (advisory)                 | Portal report form, evidence upload                                                                          | Arabic   | CDF-58 |
| A11Y-14 | Minor    | Tables add a tab stop even when they do not scroll                               | 2.4.3 Focus Order (advisory)                            | Intake list, cases list, evidence table                                                                      | Both     | CDF-52 |

### A11Y-01 · Serious · Every card on the case and intake pages is announced as the first card in Arabic

- **WCAG:** 1.3.1 Info and Relationships; 4.1.2 Name, Role, Value
- **Screen:** Case detail (7 sections), intake report detail (triage and create-case cards)
- **Language:** Arabic
- **Component:** packages/ui `CDFCard`
- **Story:** CDF-52

`CDFCard` builds the heading id with `title.replace(/\W+/g, "-")`. `\W` strips every Arabic letter, so each card gets `id="card--"`. On the case page seven sections share that id and all are named «بيانات القضية» (Case details) by `aria-labelledby`. axe reports `landmark-unique`; the sweep found `card--` ×7 on the case page and ×2 on intake detail.

**Fix.** Generate the id with `useId()` (supported in Server Components in React 19) or take an explicit `id` prop. Add an Arabic case to the a11y test that asserts section names are unique.

### A11Y-02 · Serious · Case page scrolls sideways on phones and at 400% zoom

- **WCAG:** 1.4.10 Reflow
- **Screen:** Case detail
- **Language:** Both
- **Component:** apps/investigation-web case page
- **Story:** CDF-53

At 320 CSS px the page is 671 px wide in English and 580 px in Arabic; at 390 px (phone) the Arabic page is 580 px wide and the header, banner and cards are pushed off-screen. Cause: the `grid lg:grid-cols-[2fr_1fr]` children keep `min-width: auto`, so the evidence table's min-content width (619 px) widens the whole column. Injecting `.grid > * { min-width: 0 }` brings the page back to 320 px with the table scrolling inside its own region.

**Fix.** Add `min-w-0` to both grid children in `cases/[id]/page.tsx` (or use `lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]`). Add a 320 px `scrollWidth` assertion to the a11y spec.

### A11Y-03 · Serious · Opening a report on the portal follow-up page drops keyboard focus

- **WCAG:** 2.4.3 Focus Order; 4.1.3 Status Messages
- **Screen:** Portal follow-up: after Check status, and after Sign out of follow-up
- **Language:** Both
- **Component:** apps/whistleblowing-web follow-up
- **Story:** CDF-54

After submitting a valid Report ID and secret with the keyboard, `document.activeElement` is `<body>` on desktop and phone in both languages. The form that had focus is replaced by the status view and nothing is announced, so a screen-reader user hears silence and must hunt from the top. This is the public portal, which §44 gives heightened priority.

**Fix.** Do what `ReportReceipt` already does: give the status card heading `tabIndex={-1}` and focus it on mount; when signing out of follow-up, return focus to the Report ID field.

### A11Y-04 · Serious · Workflow tracker shows which steps are done only by colour

- **WCAG:** 1.4.1 Use of Color; 1.3.1 Info and Relationships
- **Screen:** Case detail
- **Language:** Both
- **Component:** packages/ui `CDFProgressTracker`
- **Story:** CDF-55

Completed steps differ from upcoming steps only by a green fill (1.03:1 against the page) and green text. Screen readers get `aria-current="step"` on the current step and nothing for done or not-started. The tracker is also wrapped in `<nav>` and an inner `role=region` with the same label, which creates two landmarks named «Case progress» for something that is not navigation.

**Fix.** Add a non-colour cue (check icon or «Done» prefix) and visually hidden status text on each step («completed», «current», «not started»). Replace the `<nav>` with a single labelled region. Layout and clipping stay in CDF-48.

### A11Y-05 · Moderate · Every page in each app has the same title

- **WCAG:** 2.4.2 Page Titled
- **Screen:** All screens
- **Language:** Both
- **Component:** both apps, route metadata
- **Story:** CDF-56

Only the root layouts set metadata. Every portal page is titled «CDF Whistleblowing Portal» and every internal page «CDF Case Management & Investigation Platform», so browser tabs, history and screen-reader page announcements cannot tell Cases from a case or the report form from follow-up.

**Fix.** Add `generateMetadata` per route with a `{page} · {app}` template (for example «Cases · …», «CDF-DEMO-2026-0001 · …»). Never put a Report ID or secret in a portal title.

### A11Y-06 · Moderate · Session ends after 30 idle minutes with no warning

- **WCAG:** 2.2.1 Timing Adjustable
- **Screen:** Investigation app, all forms
- **Language:** Both
- **Component:** investigation-web session
- **Story:** CDF-57

`CDF_SESSION_IDLE_SECONDS` defaults to 1,800 and nothing in the app warns before expiry or offers to extend. An investigator writing a triage reason or assignment rationale slowly (screen-reader or switch user) would be signed out and lose the text on submit (inferred from the code; the 30-minute expiry itself was not exercised).

**Fix.** Show an accessible dialog two minutes before idle expiry with «Stay signed in», which refreshes the session. Keep the security limit; WCAG only needs the warning and the extension. Needs a product decision on the extension policy.

### A11Y-07 · Moderate · Internal forms do not say which fields are required

- **WCAG:** 3.3.2 Labels or Instructions; 1.3.1
- **Screen:** Evidence upload, assign person, update details, conflict declaration; portal report form (programmatic only)
- **Language:** Both
- **Component:** packages/ui `CDFField`
- **Story:** CDF-58

In the evidence form, File and Title are required while Source, Collected on and Description are optional, and none is marked. The portal marks optional fields visibly but required fields carry neither `required` nor `aria-required`, so screen readers do not announce them as required.

**Fix.** Give `CDFField` a `required` prop that renders a visible marker and sets `aria-required`; mark optional fields with the existing `(Optional)` label everywhere.

### A11Y-08 · Moderate · Server-side errors in internal forms are not tied to their fields

- **WCAG:** 3.3.1 Error Identification; 3.3.3 Error Suggestion
- **Screen:** Every `ActionForm`: triage, create case, assign, transitions, evidence, conflict
- **Language:** Both
- **Component:** investigation-web `ActionForm` + `CDFField`
- **Story:** CDF-58

`ActionForm` shows a summary alert listing «field: message», but the inputs never get `aria-invalid` or an inline error, focus is not moved to the summary, and any field missing from `fieldLabels` is listed by its raw form key. The portal report form already does this properly (inline error, `aria-describedby`, focus to the first invalid field).

**Fix.** Pass `state.fieldErrors` down through context so `CDFField` can render the inline error and `fieldIds()` attributes, focus the summary (tabIndex −1) after an invalid submit, and link each summary item to its field.

### A11Y-09 · Moderate · Heading and landmark outline has gaps

- **WCAG:** 1.3.1 Info and Relationships; 2.4.6 Headings and Labels
- **Screen:** Case detail, admin home, all pages
- **Language:** Both
- **Component:** packages/ui shell, case page
- **Story:** CDF-52

Case page jumps from h2 Evidence to h4 «Chain of custody» (axe `heading-order`). The administrator home has no h1 (`page-has-heading-one`). The evidence table region repeats the card's name «Evidence» (`landmark-unique` in English). The classification banner sits outside every landmark (axe `region`, all pages). The app navigation renders inside `<main>`, so «Skip to content» lands before it.

**Fix.** Use h3 inside evidence versions; give the admin home a page header; drop the region label when the table sits in a same-named card; move the banner into `<header>`; render `AppNav` in the shell's `nav` slot.

### A11Y-10 · Minor · Repeated controls share one name

- **WCAG:** 2.4.6 Headings and Labels (advisory)
- **Screen:** Case detail, portal receipt
- **Language:** Both
- **Component:** case page, receipt
- **Story:** CDF-53

Five «File» inputs (one per evidence item), five «New version» buttons, ten «Download» links (per row and per version), and two «Copy» buttons on the receipt. Each is understandable in context (table row or list item), so this is not a strict failure, but voice-control and screen-reader element lists show identical entries.

**Fix.** Add the item to the accessible name: «File for EV-002», «New version of EV-002», «Copy Report ID».

### A11Y-11 · Minor · Login error is announced twice

- **WCAG:** 4.1.3 Status Messages (advisory)
- **Screen:** Login
- **Language:** Both
- **Component:** login form
- **Story:** CDF-54

The error is in a `role=alert` box and repeated in a visually hidden `aria-live` paragraph.

**Fix.** Remove the extra live region.

### A11Y-12 · Minor · Reporter reference hint lives only in a title tooltip

- **WCAG:** 1.3.1 / 3.3.2 (advisory)
- **Screen:** Case detail
- **Language:** Both
- **Component:** case page
- **Story:** CDF-53

`title={t("cases.reporterRefHint")}` is not reachable by keyboard or touch.

**Fix.** Render the hint as text or `aria-describedby`.

### A11Y-13 · Minor · Date fields show the browser's mm/dd/yyyy format on Arabic pages

- **WCAG:** 3.3.2 Labels or Instructions (advisory)
- **Screen:** Portal report form, evidence upload
- **Language:** Arabic
- **Component:** forms
- **Story:** CDF-58

Native date inputs follow the browser locale, so an Arabic page shows a Latin, English-ordered placeholder.

**Fix.** Add a hint with the expected format in both languages, or use a localised date picker.

### A11Y-14 · Minor · Tables add a tab stop even when they do not scroll

- **WCAG:** 2.4.3 Focus Order (advisory)
- **Screen:** Intake list, cases list, evidence table
- **Language:** Both
- **Component:** packages/ui `CDFTable`
- **Story:** CDF-52

`CDFTable`'s wrapper always has `tabIndex=0`.

**Fix.** Only make it focusable when `scrollWidth > clientWidth` (a small client effect), or accept the extra stop.

## Already tracked from the design review

| Story  | WCAG                     | Confirmed in this audit                                                                                                                                                           |
| ------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CDF-46 | 1.4.11 Non-text Contrast | Input, select and textarea borders measure 1.50:1 on white (needs 3:1); radios and checkboxes use browser blue. Confirmed again on every form in both apps.                       |
| CDF-47 | 3.1.2 Language of Parts  | Raw codes («PUBLIC_PORTAL») and English names («Investigator Alpha», audit actors) in Arabic pages, and Latin punctuation flipping in RTL. Confirmed on case detail and evidence. |
| CDF-48 | 1.4.10 Reflow (layout)   | Tracker chips clipped at the inline end on desktop and mobile table rows. A11Y-04 covers the tracker's semantics only.                                                            |

## What passes

- Language and direction: `lang` and `dir` are correct on every page; the language switch carries `lang` and `hreflang`; report descriptions keep the reporter's language with `lang`.
- Keyboard: 1,018 tab stops walked across 76 screen states; every stop had the 3 px focus ring (4.19:1 on white, 3.8:1 on the page), none was hidden behind other content, no traps.
- Skip link present and working; `<main>` is focusable.
- Text contrast: axe found no colour-contrast failures in either language; status colours on their tints measure 6.3–7.1:1.
- Every input has a programmatic label; tables have captions and `scope=col` headers.
- Portal report form: inline errors linked with `aria-describedby`, `aria-invalid`, focus moves to the first invalid field.
- Receipt screen moves focus to its heading and announces copy success.
- Text spacing (1.4.12): no visible text clipped with WCAG spacing applied.
- Buttons and inputs are at least 44 px tall; reduced-motion is honoured.

## Method

- axe-core 4.13 through Playwright with WCAG 2.0/2.1 A and AA rules plus best practice, on every run.
- Keyboard walk with Tab on every run: focus ring present, not obscured, order, traps (1,018 stops).
- Reflow at 320 CSS px (equal to 1280 px at 400% zoom) and at 640 px (200%), measuring page `scrollWidth` and the elements that overflow.
- Text spacing per 1.4.12 injected on every run, checking for clipped text.
- Code review of `packages/ui`, both layouts, every form and the evidence panel for names, roles, states, required/optional, errors, live regions and focus handling.
- Contrast of tokens computed by hand for non-text elements (control borders, tracker fills, focus ring).

## Not covered

- No real screen reader (NVDA, VoiceOver, TalkBack) was run; semantics were checked through the accessibility tree and code. A short VoiceOver and NVDA pass in Arabic is still worth doing before UAT.
- Dark theme is defined in tokens but no page uses it, so it was not audited.
- Windows high-contrast mode and real-device zoom were not tested.
- Screens not built yet (committee, findings, records, admin) are out of scope.

## Reproducing

`sweep.cjs` in this folder is the script used. With both apps running on ports 3000 and 3001 and the CI variables exported, run `node design/accessibility-audit-2026-10-07/sweep.cjs <out-dir>`. It writes `results.json` and full-page screenshots for every run. It clears `core.rate_limit_bucket` in the local database between portal submissions, so only point it at a local throwaway database.
