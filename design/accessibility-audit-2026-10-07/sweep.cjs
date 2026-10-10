// Accessibility sweep: axe (WCAG 2.1 A/AA + best practice), reflow at 320px, text spacing, keyboard focus walk.
// Usage: node sweep.cjs <outDir>. Audit tooling, not app code; see README.md in this folder.
/* global window, document, getComputedStyle, innerWidth, innerHeight, scrollY */
/* eslint-disable @typescript-eslint/no-require-imports, no-console */
const path = require("node:path");
const fs = require("node:fs");
const repo = path.resolve(__dirname, "../..");
const { chromium } = require(path.join(repo, "node_modules/@playwright/test"));
const AxeBuilder = require(path.join(repo, "node_modules/@axe-core/playwright")).default;

const OUT = process.argv[2];
fs.mkdirSync(path.join(OUT, "shots"), { recursive: true });
const APP = "http://127.0.0.1:3000";
const PORTAL = "http://127.0.0.1:3001";
const PW = process.env.CDF_DEV_PASSWORD;
const L = {
  en: { email: "Email", password: "Password" },
  ar: { email: "البريد الإلكتروني", password: "كلمة المرور" },
};

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

async function ctxFor(browser, locale, base, vp) {
  const ctx = await browser.newContext({ baseURL: base, bypassCSP: true, ...VIEWPORTS[vp] });
  await ctx.addCookies([{ name: "cdf_locale", value: locale, url: base }]);
  return ctx;
}
async function signIn(browser, email, locale, vp) {
  clearRL();
  const ctx = await ctxFor(browser, locale, APP, vp);
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel(L[locale].email).fill(email);
  await page.getByLabel(L[locale].password).fill(PW);
  await page.getByTestId("login-submit").click();
  await page.getByTestId("signed-in-as").waitFor();
  return page;
}

const results = [];
const clearRL = () =>
  require("node:child_process").execSync(
    `psql -h 127.0.0.1 -p 54322 -U postgres -qc "delete from core.rate_limit_bucket"`,
  );

async function inspect(page, screen, locale, vp) {
  await page.waitForLoadState("networkidle").catch(() => {});
  const id = `${screen}__${locale}__${vp}`;
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .analyze();
  const pick = (list) =>
    list.map((v) => ({
      id: v.id,
      impact: v.impact,
      tags: v.tags.filter((t) => t.startsWith("wcag") || t === "best-practice"),
      help: v.help,
      nodes: v.nodes.slice(0, 8).map((n) => ({
        target: n.target.join(" "),
        html: n.html.slice(0, 200),
        summary: (n.failureSummary || "").slice(0, 300),
      })),
      count: v.nodes.length,
    }));
  await page.screenshot({ path: path.join(OUT, "shots", `${id}.png`), fullPage: true });

  // Structure: landmarks, headings, lang/dir, title.
  const structure = await page.evaluate(() => {
    const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    return {
      title: document.title,
      lang: document.documentElement.lang,
      dir: document.documentElement.dir,
      headings: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")]
        .filter(vis)
        .map((h) => `${h.tagName}:${h.textContent.trim().slice(0, 60)}`),
      landmarks: [
        ...document.querySelectorAll(
          "main,nav,header,footer,aside,[role=region],section[aria-labelledby],[role=navigation],[role=main]",
        ),
      ].map(
        (e) =>
          `${e.tagName.toLowerCase()}${e.getAttribute("role") ? "[" + e.getAttribute("role") + "]" : ""}:${e.getAttribute("aria-label") || (e.getAttribute("aria-labelledby") ? "→#" + e.getAttribute("aria-labelledby") + "=" + (document.getElementById(e.getAttribute("aria-labelledby"))?.textContent || "MISSING").slice(0, 40) : "")}`,
      ),
      dupIds: (() => {
        const m = {};
        document.querySelectorAll("[id]").forEach((e) => (m[e.id] = (m[e.id] || 0) + 1));
        return Object.entries(m).filter(([, n]) => n > 1);
      })(),
      inputs: [...document.querySelectorAll("input:not([type=hidden]),select,textarea")].map((i) => ({
        id: i.id,
        type: i.type,
        required: i.required,
        ariaRequired: i.getAttribute("aria-required"),
        invalid: i.getAttribute("aria-invalid"),
        describedby: i.getAttribute("aria-describedby"),
        label: i.labels && i.labels[0] ? i.labels[0].textContent.trim().slice(0, 60) : null,
        autocomplete: i.getAttribute("autocomplete"),
      })),
    };
  });

  // Control borders vs their background (WCAG 1.4.11) and focus indicator check.
  const nonText = await page.evaluate(() => {
    const parse = (c) => (c.match(/[\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return +((x + 0.05) / (y + 0.05)).toFixed(2);
    };
    const bgOf = (el) => {
      for (let e = el.parentElement; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c.length === 3 || (c.length === 4 && c[3] > 0)) return c.slice(0, 3);
      }
      return [255, 255, 255];
    };
    return [...document.querySelectorAll("input:not([type=hidden]),select,textarea,button")]
      .filter((e) => e.offsetWidth)
      .map((e) => {
        const s = getComputedStyle(e);
        const bw = parseFloat(s.borderTopWidth);
        const bg = parse(s.backgroundColor);
        const own = bg.length === 3 || (bg.length === 4 && bg[3] > 0) ? bg.slice(0, 3) : null;
        return {
          el: `${e.tagName.toLowerCase()}#${e.id || ""}[${e.type || ""}] ${(e.textContent || "").trim().slice(0, 30)}`,
          border: bw > 0 ? ratio(parse(s.borderTopColor).slice(0, 3), bgOf(e)) : null,
          fill: own ? ratio(own, bgOf(e)) : null,
          accent: s.accentColor,
          w: e.offsetWidth,
          h: e.offsetHeight,
        };
      });
  });

  // Keyboard walk.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.click(1, 1).catch(() => {});
  await page.evaluate(
    () => document.activeElement && document.activeElement.blur && document.activeElement.blur(),
  );
  const focus = [];
  const seen = new Set();
  for (let i = 0; i < 70; i++) {
    await page.keyboard.press("Tab");
    const f = await page.evaluate(() => {
      const e = document.activeElement;
      if (!e || e === document.body) return null;
      const s = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      const name = (e.getAttribute("aria-label") || e.textContent || e.value || e.id || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 50);
      const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
      const shadow = s.boxShadow && s.boxShadow !== "none";
      // obscured: element at centre is not e or inside e
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
      const cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
      const top = document.elementFromPoint(cx, cy);
      return {
        key:
          e.tagName +
          "|" +
          (e.id || "") +
          "|" +
          name +
          "|" +
          Math.round(r.top + scrollY) +
          "|" +
          Math.round(r.left),
        el: `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${e.getAttribute("role") ? "[" + e.getAttribute("role") + "]" : ""}`,
        name,
        visibleIndicator: outline || shadow,
        outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`,
        inView: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
        obscured: !!top && top !== e && !e.contains(top) && !top.contains(e),
        size: `${Math.round(r.width)}x${Math.round(r.height)}`,
      };
    });
    if (!f) {
      focus.push({ el: "body", name: "(focus on body)" });
      continue;
    }
    if (focus.length && focus[focus.length - 1].key === f.key) continue;
    if (seen.has(f.key)) break;
    seen.add(f.key);
    focus.push(f);
  }

  // Reflow at 320 CSS px (WCAG 1.4.10) and text spacing (1.4.12).
  const orig = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 640 });
  await page.waitForTimeout(150);
  const reflow = await page.evaluate(() => {
    const over = [];
    const inScroller = (el) => {
      for (let e = el.parentElement; e; e = e.parentElement) {
        const ox = getComputedStyle(e).overflowX;
        if (ox === "auto" || ox === "scroll") return true;
      }
      return false;
    };
    document.querySelectorAll("body *").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width && (r.right > innerWidth + 1 || r.left < -1) && !inScroller(el))
        over.push(
          `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${(el.className && el.className.toString().split(" ").slice(0, 3).join(".")) || ""} [${Math.round(r.left)}..${Math.round(r.right)}] ${(el.textContent || "").trim().slice(0, 40)}`,
        );
    });
    return { scrollWidth: document.documentElement.scrollWidth, innerWidth, over: over.slice(0, 15) };
  });
  await page.screenshot({ path: path.join(OUT, "shots", `${id}__320.png`), fullPage: true });
  const spacingTag = await page.addStyleTag({
    content:
      "*{line-height:1.5!important;letter-spacing:0.12em!important;word-spacing:0.16em!important}p{margin-bottom:2em!important}",
  });
  await page.waitForTimeout(150);
  const spacing = await page.evaluate(() => {
    const clipped = [];
    document.querySelectorAll("body *").forEach((el) => {
      const s = getComputedStyle(el);
      if (
        (s.overflow === "hidden" ||
          s.overflowX === "hidden" ||
          s.overflowY === "hidden" ||
          s.textOverflow === "ellipsis") &&
        (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) &&
        el.clientWidth > 0
      )
        clipped.push(`${el.tagName.toLowerCase()}.${el.className.toString().slice(0, 60)}`);
    });
    return { scrollWidth: document.documentElement.scrollWidth, clipped: clipped.slice(0, 10) };
  });
  await spacingTag.evaluate((e) => e.remove());
  await page.setViewportSize(orig);
  await page.waitForTimeout(150);

  const rec = {
    id,
    screen,
    locale,
    vp,
    url: page.url(),
    violations: pick(axe.violations),
    incomplete: pick(
      axe.incomplete.filter((v) =>
        ["color-contrast", "aria-valid-attr-value", "duplicate-id-aria", "label"].includes(v.id),
      ),
    ),
    structure,
    nonText,
    focus,
    reflow,
    spacing,
  };
  results.push(rec);
  console.log(
    `${id}: ${rec.violations.map((v) => `${v.id}(${v.impact},${v.count})`).join(" ") || "no axe violations"} | reflow sw=${reflow.scrollWidth} | focus stops=${focus.length}`,
  );
}

async function run() {
  const browser = await chromium.launch({ executablePath: process.env.CDF_E2E_CHROMIUM });
  clearRL();
  // One-time setup in English desktop: a portal report for follow-up, an ACCEPTED report, an evidence item.
  const setup = {};
  {
    const ctx = await ctxFor(browser, "en", PORTAL, "desktop");
    const p = await ctx.newPage();
    await p.goto("/report");
    await p.locator("#category").selectOption("PROCUREMENT");
    await p
      .locator("#description")
      .fill(
        "Synthetic audit report: invoices for a fictional supplier appear duplicated across two quarters.",
      );
    await p.locator('input[name="acknowledgement"]').check();
    await p.getByTestId("submit-report").click();
    await p.getByTestId("report-receipt").waitFor();
    setup.ref = (await p.getByTestId("receipt-ref").textContent()).trim();
    setup.secret = (await p.getByTestId("receipt-secret").textContent()).trim();
    await ctx.close();
    const tri = await signIn(browser, "triage@example.test", "en", "desktop");
    await tri.goto("/intake");
    await tri.locator(`[data-testid="report-${setup.ref}"]`).click();
    await tri.waitForURL(/\/intake\/[0-9a-f-]{36}/);
    setup.newReportUrl = tri.url();
    await tri.locator("#outcome").selectOption("OPEN_CASE");
    await tri.locator("#reason").fill("Synthetic triage decision for the accessibility audit.");
    await tri.getByTestId("triage-form").locator('button[type="submit"]').click();
    await tri.getByTestId("create-case-card").waitFor({ timeout: 15000 });
    // Reply so the portal shows a message from CDF.
    await tri.locator("#body").fill("Thank you. This is a synthetic reply from the intake team.");
    await tri.getByTestId("reply-form").locator('button[type="submit"]').click();
    await tri.waitForTimeout(1000);
    await tri.goto("/intake");
    await tri.locator('[data-testid="report-WB-SEED00000006"]').click();
    await tri.waitForURL(/\/intake\/[0-9a-f-]{36}/);
    setup.triageUrl = tri.url();
    await tri.context().close();
    const cm = await signIn(browser, "casemanager@example.test", "en", "desktop");
    await cm.goto("/cases");
    await cm.locator('[data-testid^="case-CDF-DEMO-"][data-testid$="-0001"]').click();
    await cm.waitForURL(/\/cases\/[0-9a-f-]{36}/);
    setup.caseUrl = cm.url();
    const form = cm.getByTestId("evidence-form");
    await form.locator("#file").setInputFiles({
      name: "synthetic-ledger.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7\n% synthetic audit evidence\n"),
    });
    await form.locator("#evidenceTitle").fill("Synthetic ledger extract");
    await form.locator('button[type="submit"]').click();
    await form.getByRole("status").waitFor({ timeout: 20000 });
    await cm.context().close();
    console.log("setup", setup);
  }

  for (const locale of ["ar", "en"]) {
    for (const vp of ["desktop", "phone"]) {
      // ---- Portal
      let ctx = await ctxFor(browser, locale, PORTAL, vp);
      let p = await ctx.newPage();
      await p.goto("/");
      await inspect(p, "portal-home", locale, vp);
      await p.goto("/report");
      await inspect(p, "portal-report", locale, vp);
      await p.getByTestId("mode-identified").check();
      await inspect(p, "portal-report-identified", locale, vp);
      clearRL();
      await p.goto("/report");
      await p.getByTestId("submit-report").click();
      await p.locator("[aria-invalid=true]").first().waitFor();
      const focused = await p.evaluate(
        () => document.activeElement && (document.activeElement.id || document.activeElement.tagName),
      );
      results.push({
        id: `note__portal-report-invalid-focus__${locale}__${vp}`,
        note: `after invalid submit focus on: ${focused}`,
      });
      await inspect(p, "portal-report-invalid", locale, vp);
      clearRL();
      await p.goto("/report");
      await p
        .locator("#category")
        .selectOption("OTHER")
        .catch(async () => p.locator("#category").selectOption({ index: 1 }));
      await p
        .locator("#description")
        .fill("Synthetic audit report used to check the receipt screen in each language.");
      await p.locator('input[name="acknowledgement"]').check();
      await p.getByTestId("submit-report").click();
      await p.getByTestId("report-receipt").waitFor();
      results.push({
        id: `note__receipt-focus__${locale}__${vp}`,
        note: await p.evaluate(() => document.activeElement.outerHTML.slice(0, 120)),
      });
      await inspect(p, "portal-receipt", locale, vp);
      await p.goto("/follow-up");
      await inspect(p, "portal-follow-up", locale, vp);
      await p.locator("#reportRef").fill("WB-NOPE0000000");
      await p.locator("#secret").fill("wrong-secret-value");
      await p.getByTestId("open-report").click();
      await p.getByTestId("follow-up-error").waitFor();
      await inspect(p, "portal-follow-up-error", locale, vp);
      await p.goto("/follow-up");
      await p.locator("#reportRef").fill(setup.ref);
      await p.locator("#secret").fill(setup.secret);
      await p.getByTestId("open-report").focus();
      await p.keyboard.press("Enter");
      await p.getByTestId("report-status").waitFor();
      results.push({
        id: `note__followup-open-focus__${locale}__${vp}`,
        note: await p.evaluate(() =>
          document.activeElement === document.body ? "BODY" : document.activeElement.outerHTML.slice(0, 120),
        ),
      });
      await inspect(p, "portal-follow-up-status", locale, vp);
      await ctx.close();

      // ---- Investigation app
      ctx = await ctxFor(browser, locale, APP, vp);
      p = await ctx.newPage();
      clearRL();
      await p.goto("/login");
      await inspect(p, "app-login", locale, vp);
      await p.getByLabel(L[locale].email).fill("nobody@example.test");
      await p.getByLabel(L[locale].password).fill("wrong-password-123");
      await p.getByTestId("login-submit").click();
      await p.getByTestId("login-error").waitFor();
      await inspect(p, "app-login-error", locale, vp);
      await p.goto("/does-not-exist");
      await inspect(p, "app-404", locale, vp);
      await ctx.close();

      p = await signIn(browser, "triage@example.test", locale, vp);
      await p.goto("/intake");
      await inspect(p, "app-intake-list", locale, vp);
      await p.goto(setup.triageUrl);
      await inspect(p, "app-intake-triage", locale, vp);
      await p.getByTestId("triage-form").evaluate((f) => f.requestSubmit());
      await p.getByTestId("triage-form").getByRole("alert").waitFor();
      results.push({
        id: `note__actionform-invalid-focus__${locale}__${vp}`,
        note: await p.evaluate(() =>
          document.activeElement === document.body ? "BODY" : document.activeElement.outerHTML.slice(0, 120),
        ),
      });
      await inspect(p, "app-intake-triage-invalid", locale, vp);
      await p.goto(setup.newReportUrl);
      await inspect(p, "app-intake-create-case", locale, vp);
      await p.context().close();

      p = await signIn(browser, "casemanager@example.test", locale, vp);
      await p.goto("/cases");
      await inspect(p, "app-cases-list", locale, vp);
      await p.goto(setup.caseUrl);
      await p.locator("details").evaluateAll((ds) => ds.forEach((d) => (d.open = true)));
      await inspect(p, "app-case-detail", locale, vp);
      await p.getByTestId("assign-form").evaluate((f) => f.requestSubmit());
      await p.getByTestId("assign-form").getByRole("alert").waitFor();
      await inspect(p, "app-case-assign-invalid", locale, vp);
      await p.context().close();

      p = await signIn(browser, "admin@example.test", locale, vp);
      await inspect(p, "app-admin-home", locale, vp);
      await p.context().close();
    }
  }
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ setup, results }, null, 1));
  await browser.close();
}
run().catch((e) => {
  fs.writeFileSync(path.join(OUT, "results.partial.json"), JSON.stringify(results, null, 1));
  console.error(e);
  process.exit(1);
});
