// Phase 12 P12-1 (ADR-017 to ADR-019; DEC-61, DEC-F19; AMB-029, AMB-105): the Allegations and Proceedings tabs in
// Arabic (RTL) and English (LTR). The case manager names a person, ties the report's allegation to them and opens an
// investigation; the investigator records a finding twice, and both versions stay on record. The case manager moves
// a proceeding along and cancels one after confirming. The referral to the Investigation Committee waits for the
// preliminary review to refer the case (AMB-018) and offers no form until then; the case manager then refers it,
// after seeing what the referral would copy now (migration 2045), and sees the committee as copied at referral, both
// in counts and never names. On a restricted case the referral also waits for the case owner's approval as Restricted
// Case Authority, offered only once the preliminary review referred the case, with the same counts; the investigator
// sees why and cannot approve, and gets no counts; the case manager, off the restricted team, gets the same 404 as a
// missing case. Synthetic data only.
import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  closeFixtureConnections,
  endInvestigatorAssignment,
  openInvestigation,
  preliminaryReferral,
  restrictedStructureCase,
  structureCase,
  withSeatedInvestigationCommittee,
} from "./records-fixture";
import { signIn } from "./support";

// Investigator Alpha joins every case made here; after each test they leave it again, so the seed's "my cases" stay
// as they were for the specs that count them (shell). The restricted case is left through its owner.
const joined: { caseId: string; by: "caseManager" | "grcDirector" }[] = [];
test.afterEach(async () => {
  for (const c of joined.splice(0)) await endInvestigatorAssignment(c.caseId, c.by);
});
test.afterAll(closeFixtureConnections);

const PERSON = "Employee Kappa (synthetic)";
const POLICY = "Code of Conduct art. 7 (synthetic)";
const REASON = "Synthetic: the next step for the e2e check.";
// Everyone who can hold a seat at referral, in both languages: the seed's demo committee
// (30_synthetic_committee_seats.sql) and the users the fixture seats where a seat is empty. The committee snapshot
// names none of them.
const MEMBERS = [
  "Investigation Committee Chair Psi (demo)",
  "رئيس لجنة التحقيق بساي (تجريبي)",
  "Investigation Committee Deputy Chair Omega (demo)",
  "نائب رئيس لجنة التحقيق أوميغا (تجريبي)",
  "Investigation Committee Secretary Alpha (demo)",
  "أمين سر لجنة التحقيق ألفا (تجريبي)",
  "Investigation Committee Member Beta (demo)",
  "عضو لجنة التحقيق بيتا (تجريبي)",
  "Investigation Committee Member Gamma (demo)",
  "عضو لجنة التحقيق جاما (تجريبي)",
  "Committee Chair Xi",
  "رئيس اللجنة كسي",
  "Committee Secretary Nu",
  "أمين سر اللجنة نو",
  "Legal Reviewer Omicron",
  "المراجع القانوني أوميكرون",
];

const TEXT = {
  en: {
    version: (n: number) => `version ${n}`,
    earlier: "Earlier versions (1)",
    notReferred: "Not referred.",
    referred: "Referred on",
    awaitingPreliminary: "Waiting for the preliminary review to refer the case to the committee.",
    awaitPreliminary: "You can refer once the preliminary review refers the case to the committee.",
    awaitingApproval: "Waiting for the Restricted Case Authority's approval.",
    approved: "Ready to refer.",
    authority: "GRC Director Zeta",
    cannotEdit: "Referral belongs to the people who edit the case.",
    canApprove: "You can approve this referral as the case's Restricted Case Authority.",
    withCommittee: "The committee works the case from its own list.",
  },
  ar: {
    version: (n: number) => `الإصدار ${n}`,
    earlier: "إصدارات سابقة (1)",
    notReferred: "لم تُحَل.",
    referred: "أُحيلت في",
    awaitingPreliminary: "بانتظار أن تُحيل المراجعة الأولية القضية إلى اللجنة.",
    awaitPreliminary: "يمكنك الإحالة بعد أن تُحيل المراجعة الأولية القضية إلى اللجنة.",
    awaitingApproval: "بانتظار موافقة صاحب الصلاحية على القضية المقيّدة.",
    approved: "وهي جاهزة للإحالة.",
    authority: "مدير الحوكمة زيتا",
    cannotEdit: "الإحالة من اختصاص من يعدّلون القضية.",
    canApprove: "يمكنك الموافقة على هذه الإحالة بصفتك صاحب الصلاحية على القضية المقيّدة.",
    withCommittee: "تعمل اللجنة على القضية من قائمتها الخاصة.",
  },
} as const;

const label = (what: string) => `${what}-${randomUUID().slice(0, 8)}`;

async function teamCase(what: string) {
  const c = await structureCase(label(what));
  joined.push({ caseId: c.caseId, by: "caseManager" });
  return c;
}

async function restrictedCase(what: string) {
  const c = await restrictedStructureCase(label(what));
  joined.push({ caseId: c.caseId, by: "grcDirector" });
  return c;
}

/** Opens a disclosure unless it already is (a server re-render keeps one that stayed in place open). */
async function open(details: Locator) {
  await expect(details).toBeVisible();
  if (!(await details.evaluate((d) => (d as HTMLDetailsElement).open)))
    await details.locator("summary").click();
}

/** Submits a command form and accepts its confirmation (UX-031). */
async function submitConfirmed(page: Page, form: Locator) {
  await form.locator('button[type="submit"]').click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("confirm-submit").click();
  await expect(dialog).toBeHidden();
}

const states = (tracker: Locator) =>
  tracker.locator("li").evaluateAll((li) => li.map((x) => x.getAttribute("data-state")));

// What a referral would copy now on a seeded database (migration 2045): the demo committee in office, per seat
// (chair, deputy chair, secretary, two members), then four voting, five cleared and none without access.
const PREVIEW = ["1", "1", "1", "2", "4", "5", "0"];

for (const locale of ["ar", "en"] as const) {
  const text = TEXT[locale];

  test(`${locale}: the team names a person, ties the allegation and records a finding twice`, async ({
    browser,
  }) => {
    const c = await teamCase(`structure-${locale}`);
    const manager = await signIn(browser, "casemanager@example.test", locale);
    await manager.goto(`/cases/${c.caseId}/allegations`);
    await expect(manager.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(manager.getByTestId("subjects-empty")).toBeVisible();
    // The report's allegation is not tied to anyone yet, and there is no one to tie it to.
    await expect(manager.getByTestId("allegations-unlinked").getByTestId("allegation-1")).toBeVisible();
    await expect(manager.getByTestId("allegation-1-link")).toHaveCount(0);

    // Name a person.
    await open(manager.getByTestId("add-subject"));
    await manager.locator("#subjectLabel").fill(PERSON);
    await manager.getByTestId("add-subject-form").locator('button[type="submit"]').click();
    await expect(manager.getByTestId("subject-1")).toContainText(PERSON);
    expect(await states(manager.getByTestId("subject-1-path"))).toEqual(["current", "upcoming", "upcoming"]);

    // Tie the allegation to them, with a policy reference.
    await open(manager.getByTestId("allegation-1-link"));
    await manager.locator("#link-1-subject").selectOption({ label: PERSON });
    await manager.locator("#link-1-policy").fill(POLICY);
    await manager.getByTestId("allegation-1-link-form").locator('button[type="submit"]').click();
    const about = manager.getByTestId("allegations-about-1");
    await expect(about.getByTestId("allegation-1")).toBeVisible();
    await expect(about.getByTestId("allegation-1-refs")).toContainText(POLICY);
    await expect(manager.getByTestId("allegations-unlinked")).toHaveCount(0);
    expect(await states(manager.getByTestId("subject-1-path"))).toEqual(["done", "current", "upcoming"]);

    // A finding needs a proceeding: the link goes to the place to open one.
    await manager.getByTestId("allegation-1-needs-proceeding").getByRole("link").click();
    await manager.waitForURL(new RegExp(`/cases/${c.caseId}/proceedings#open-proceeding$`));
    await expect(manager.getByTestId("proceedings-empty")).toBeVisible();
    await manager.locator("#proceedingType").selectOption("INVESTIGATION");
    await manager.locator("#proceedingReason").fill(REASON);
    await manager.getByTestId("open-proceeding-form").locator('button[type="submit"]').click();
    await expect(manager.getByTestId("proceeding-1-status")).toHaveAttribute("data-status", "OPEN");
    // One investigation at a time: it is no longer offered; a parallel type still is.
    await expect(manager.locator('#proceedingType option[value="INVESTIGATION"]')).toHaveCount(0);
    await expect(manager.locator('#proceedingType option[value="REINVESTIGATION"]')).toHaveCount(1);
    await manager.context().close();

    // The investigator records findings but does not edit the case.
    const investigator = await signIn(browser, "investigator.a@example.test", locale);
    await investigator.goto(`/cases/${c.caseId}/allegations`);
    await expect(investigator.getByTestId("subject-1")).toContainText(PERSON);
    await expect(investigator.getByTestId("add-subject")).toHaveCount(0);
    await expect(investigator.getByTestId("add-allegation-card")).toHaveCount(0);

    const record = async (result: string, rationale: string) => {
      await open(investigator.getByTestId("allegation-1-record"));
      // ASK ONCE, DERIVE: the open investigation and the allegation's person are already chosen.
      await expect(investigator.locator("#finding-1-subject")).not.toHaveValue("");
      await investigator.locator("#finding-1-result").selectOption(result);
      await investigator.locator("#finding-1-rationale").fill(rationale);
      await investigator.getByTestId("allegation-1-record-form").locator('button[type="submit"]').click();
    };
    const line = investigator.getByTestId("finding-1-1-1");
    await record("SUBSTANTIATED", "Synthetic: the first reading of the records.");
    await expect(line).toContainText(text.version(1));
    await record("PARTIALLY_SUBSTANTIATED", "Synthetic: after the second interview, only part is supported.");
    await expect(line).toContainText(text.version(2));
    await expect(line).toContainText("Synthetic: after the second interview, only part is supported.");
    // The first version stays on record, folded away.
    await line.locator("details summary").click();
    await expect(line.locator("details")).toContainText(text.earlier);
    await expect(line.locator("details")).toContainText("Synthetic: the first reading of the records.");
    // An investigation finding is on record, but the decision waits for the committee's (AMB-029).
    await expect(line).toHaveAttribute("data-governing", "false");
    await expect(investigator.getByTestId("allegation-1-no-governing")).toBeVisible();
    expect(await states(investigator.getByTestId("subject-1-path"))).toEqual(["done", "done", "current"]);

    // On the proceedings tab the investigator changes nothing and is told who refers.
    await investigator.goto(`/cases/${c.caseId}/proceedings`);
    await expect(investigator.getByTestId("proceeding-1")).toBeVisible();
    await expect(investigator.getByTestId("open-proceeding-card")).toHaveCount(0);
    await expect(investigator.getByTestId("proceeding-1-state")).toHaveCount(0);
    await expect(investigator.getByTestId("proceeding-1-close")).toHaveCount(0);
    const guide = investigator.getByTestId("referral-guide");
    await expect(guide).toHaveAttribute("data-can-act", "false");
    await expect(investigator.getByTestId("referral-guide-you")).toHaveText(text.cannotEdit);
    await expect(investigator.getByTestId("refer-form")).toHaveCount(0);
    await investigator.context().close();
  });

  test(`${locale}: the case manager moves a proceeding along and cancels one after confirming`, async ({
    browser,
  }) => {
    const c = await teamCase(`proceedings-${locale}`);
    await openInvestigation(c.caseId);
    const manager = await signIn(browser, "casemanager@example.test", locale);
    await manager.goto(`/cases/${c.caseId}/proceedings`);

    await open(manager.getByTestId("proceeding-1-state"));
    await manager.locator("#state-1-status").selectOption("IN_PROGRESS");
    await manager.locator("#state-1-waiting").selectOption("DOCUMENTS");
    await manager.locator("#state-1-reason").fill(REASON);
    await manager.getByTestId("proceeding-1-state-form").locator('button[type="submit"]').click();
    await expect(manager.getByTestId("proceeding-1-status")).toHaveAttribute("data-status", "IN_PROGRESS");
    await expect(manager.getByTestId("proceeding-1-waiting")).toBeVisible();

    // A corrective action under the investigation, then cancelled: closing asks first.
    await manager.locator("#proceedingType").selectOption("CORRECTIVE_ACTION");
    await manager.locator("#proceedingParent").selectOption({ index: 1 });
    await manager.locator("#proceedingReason").fill(REASON);
    await manager.getByTestId("open-proceeding-form").locator('button[type="submit"]').click();
    await expect(manager.getByTestId("proceeding-2-status")).toHaveAttribute("data-status", "OPEN");
    await open(manager.getByTestId("proceeding-2-close"));
    await manager.locator("#close-2-status").selectOption("CANCELLED");
    await manager.locator("#close-2-reason").fill(REASON);
    await submitConfirmed(manager, manager.getByTestId("proceeding-2-close-form"));
    await expect(manager.getByTestId("proceeding-2-status")).toHaveAttribute("data-status", "CANCELLED");
    // A closed proceeding no longer changes.
    await expect(manager.getByTestId("proceeding-2-state")).toHaveCount(0);
    await expect(manager.getByTestId("proceeding-2-close")).toHaveCount(0);
    await manager.context().close();
  });

  test(`${locale}: the case manager refers the case; the committee is copied at referral as counts`, async ({
    browser,
  }) => {
    const c = await teamCase(`referral-${locale}`);
    const investigation = await openInvestigation(c.caseId);
    const manager = await signIn(browser, "casemanager@example.test", locale);
    // AMB-018: until the preliminary review refers the case, the guide says so and offers no referral.
    await manager.goto(`/cases/${c.caseId}/proceedings`);
    await expect(manager.getByTestId("referral-guide")).toHaveAttribute("data-can-act", "false");
    await expect(manager.getByTestId("referral-now")).toHaveText(text.awaitingPreliminary);
    await expect(manager.getByTestId("referral-guide-you")).toHaveText(text.awaitPreliminary);
    expect(await states(manager.getByTestId("referral-guide-path"))).toEqual([
      "current",
      "upcoming",
      "upcoming",
    ]);
    await expect(manager.getByTestId("refer-form")).toHaveCount(0);
    await expect(manager.getByTestId("referral-preview")).toHaveCount(0);

    await preliminaryReferral(c.caseId);
    await withSeatedInvestigationCommittee(async () => {
      await manager.reload();
      await expect(manager.getByTestId("referral-guide")).toHaveAttribute("data-can-act", "true");
      await expect(manager.getByTestId("referral-now")).toHaveText(text.notReferred);
      expect(await states(manager.getByTestId("referral-guide-path"))).toEqual([
        "done",
        "current",
        "upcoming",
      ]);
      // The preliminary review is on record, concluded with its outcome.
      await expect(manager.getByTestId("proceeding-2-status")).toHaveAttribute("data-status", "CONCLUDED");
      await expect(manager.getByTestId("proceeding-2-outcome")).toBeVisible();
      // ASK ONCE, DERIVE: the referral follows the open investigation.
      await expect(manager.locator("#referParent")).toHaveValue(investigation);
      // Before referring: what the referral would copy now, in counts, never a name.
      const preview = manager.getByTestId("referral-preview");
      await expect(manager.getByTestId("referral-preview-seats").locator("dd")).toHaveText(PREVIEW);
      for (const name of MEMBERS) await expect(preview).not.toContainText(name);
      await manager.locator("#referReason").fill(REASON);
      await manager.getByTestId("refer-form").locator('button[type="submit"]').click();
      const dialog = manager.getByRole("dialog");
      // The confirmation repeats the totals: voting, cleared, without access.
      await expect(dialog.getByTestId("confirm-fact").locator("dd")).toHaveText(PREVIEW.slice(-3));
      await dialog.getByTestId("confirm-submit").click();
      await expect(dialog).toBeHidden();
      await expect(manager.getByTestId("committee-snapshot-3")).toBeVisible();
    });

    // The copy taken at referral, after any seat the fixture added has ended: the seed's demo committee in office
    // then, in counts (chair, deputy chair, secretary, two members; four voting; all cleared for the case).
    await manager.reload();
    const snapshot = manager.getByTestId("committee-snapshot-3");
    await expect(manager.getByTestId("committee-snapshot-3-seats").locator("dd")).toHaveText([
      "1",
      "1",
      "1",
      "2",
      "4",
      "0",
    ]);
    await expect(manager.getByTestId("committee-snapshot-3-not-cleared")).toHaveText("0");
    await expect(manager.getByTestId("committee-snapshot-3-rules")).toHaveAttribute(
      "data-source",
      "OWNER_DEFAULT",
    );
    for (const name of MEMBERS) await expect(snapshot).not.toContainText(name);
    await expect(manager.getByTestId("proceeding-3-status")).toHaveAttribute("data-status", "OPEN");
    await expect(manager.getByTestId("referral-now")).toContainText(text.referred);
    await expect(manager.getByTestId("referral-now")).toContainText("PRC-003");
    expect(await states(manager.getByTestId("referral-guide-path"))).toEqual(["done", "done", "current"]);
    await expect(manager.getByTestId("referral-guide-you")).toHaveText(text.withCommittee);
    await expect(manager.getByTestId("refer-form")).toHaveCount(0);
    await expect(manager.getByTestId("referral-preview")).toHaveCount(0);
    await manager.context().close();
  });

  test(`${locale}: a restricted case is referred only after its authority approves`, async ({ browser }) => {
    const c = await restrictedCase(`restricted-${locale}`);

    // Off the restricted team, the case manager gets the same 404 as a case that does not exist.
    const manager = await signIn(browser, "casemanager@example.test", locale);
    for (const tab of ["proceedings", "allegations"])
      expect((await manager.goto(`/cases/${c.caseId}/${tab}`))?.status(), tab).toBe(404);
    await manager.context().close();

    // The approval is offered once the preliminary review has referred the case (AMB-018), not before.
    const owner = await signIn(browser, "grc.director@example.test", locale);
    await owner.goto(`/cases/${c.caseId}/proceedings`);
    await expect(owner.getByTestId("referral-guide")).toHaveAttribute("data-can-act", "false");
    await expect(owner.getByTestId("referral-now")).toHaveText(text.awaitingPreliminary);
    expect(await states(owner.getByTestId("referral-guide-path"))).toEqual([
      "current",
      "upcoming",
      "upcoming",
      "upcoming",
    ]);
    await expect(owner.getByTestId("approve-referral-form")).toHaveCount(0);
    await expect(owner.getByTestId("referral-preview")).toHaveCount(0);
    await preliminaryReferral(c.caseId);

    // The investigator sees what the referral waits for, and who acts; they cannot approve.
    const investigator = await signIn(browser, "investigator.a@example.test", locale);
    await investigator.goto(`/cases/${c.caseId}/proceedings`);
    await expect(investigator.getByTestId("referral-guide")).toHaveAttribute("data-can-act", "false");
    await expect(investigator.getByTestId("referral-now")).toHaveText(text.awaitingApproval);
    await expect(investigator.getByTestId("referral-next")).toContainText(text.authority);
    expect(await states(investigator.getByTestId("referral-guide-path"))).toEqual([
      "done",
      "current",
      "upcoming",
      "upcoming",
    ]);
    await expect(investigator.getByTestId("approve-referral-form")).toHaveCount(0);
    await expect(investigator.getByTestId("refer-form")).toHaveCount(0);
    await expect(investigator.getByTestId("referral-preview")).toHaveCount(0);
    await investigator.context().close();

    // The case owner approves as Restricted Case Authority, after a confirmation that says what follows.
    await owner.reload();
    await expect(owner.getByTestId("referral-guide")).toHaveAttribute("data-can-act", "true");
    await expect(owner.getByTestId("referral-guide-you")).toHaveText(text.canApprove);
    // The authority sees what the referral would copy now before approving it (DEC-F19), and the confirmation
    // repeats the totals after what an uncleared member cannot do and the single use.
    await expect(owner.getByTestId("referral-preview-seats").locator("dd")).toHaveText(PREVIEW);
    await owner.locator("#approveReason").fill(REASON);
    await owner.getByTestId("approve-referral-form").locator('button[type="submit"]').click();
    const dialog = owner.getByRole("dialog");
    const facts = dialog.getByTestId("confirm-fact").locator("dd");
    await expect(facts).toHaveCount(5);
    for (const [i, n] of PREVIEW.slice(-3).entries()) await expect(facts.nth(2 + i)).toHaveText(n);
    await dialog.getByTestId("confirm-submit").click();
    await expect(owner.getByTestId("referral-approval-1")).toHaveAttribute("data-used", "false");
    await expect(owner.getByTestId("referral-now")).toContainText(text.approved);
    expect(await states(owner.getByTestId("referral-guide-path"))).toEqual([
      "done",
      "done",
      "current",
      "upcoming",
    ]);
    await expect(owner.getByTestId("approve-referral-form")).toHaveCount(0);

    // The approval serves one referral.
    await withSeatedInvestigationCommittee(async () => {
      await owner.locator("#referReason").fill(REASON);
      await submitConfirmed(owner, owner.getByTestId("refer-form"));
      await expect(owner.getByTestId("referral-approval-1")).toHaveAttribute("data-used", "true");
    });
    await expect(owner.getByTestId("committee-snapshot-2-not-cleared")).toHaveText("0");
    expect(await states(owner.getByTestId("referral-guide-path"))).toEqual([
      "done",
      "done",
      "done",
      "current",
    ]);
    await owner.context().close();
  });
}
