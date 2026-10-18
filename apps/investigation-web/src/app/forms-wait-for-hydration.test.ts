// CDF-255: every form of this app that posts waits until the page is interactive. Command forms do it themselves
// (CDFCommandForm, packages/ui/src/hydration.test.ts); any other <form> must submit only through CDFSubmitButton or
// a button disabled until `hydrated`. Otherwise the browser posts it on its own before hydration (a click, or Enter in
// a field) and, with no referrer to send, the post carries `Origin: null`, which Next.js refuses with a bare error page.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

/** The JSX opening tag that starts at `at`, skipping any `>` inside `{…}`. */
function openingTag(text: string, at: number): string {
  let depth = 0;
  for (let i = at; i < text.length; i += 1) {
    const c = text[i];
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    else if (c === ">" && depth === 0) return text.slice(at, i + 1);
  }
  return text.slice(at);
}

interface Form {
  file: string;
  tag: string;
  body: string;
}

const forms: Form[] = sources(SRC).flatMap((file) => {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/<form\b/g)].map((m) => {
    const tag = openingTag(text, m.index);
    const start = m.index + tag.length;
    return { file: relative(SRC, file), tag, body: text.slice(start, text.indexOf("</form>", start)) };
  });
});

/** Every control in the form's body that submits it: a button (its default type is submit) or a submit input. */
function submitControls(body: string): string[] {
  return [...body.matchAll(/<([A-Za-z][\w.]*)\b/g)]
    .map((m) => ({ name: m[1]!, tag: openingTag(body, m.index) }))
    .filter(({ name, tag }) => {
      if (name === "CDFSubmitButton") return true;
      if (name === "button") return !/\btype="(button|reset)"/.test(tag);
      return /\btype="(submit|image)"/.test(tag);
    })
    .map(({ tag }) => tag);
}

const waitsForHydration = (tag: string) =>
  tag.startsWith("<CDFSubmitButton") || /\bdisabled=\{[^}]*!hydrated\b/.test(tag);

describe("forms that post wait until the page is interactive (CDF-255)", () => {
  const posting = forms.filter((f) => !/\bmethod="get"/.test(f.tag));

  it("covers every form outside CDFCommandForm: sign-in and both sign-outs", () => {
    expect(posting.map((f) => f.file).sort()).toEqual([
      join("app", "(public)", "login", "login-form.tsx"),
      join("app", "(shell)", "layout.tsx"),
      join("app", "session", "session-timeout.tsx"),
    ]);
  });

  it.each(posting.map((f) => [f.file, f] as const))(
    "%s submits only once the page is interactive",
    (_, form) => {
      const controls = submitControls(form.body);
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls) expect(control, form.file).toSatisfy(waitsForHydration);
    },
  );

  it("a search form that only reads may stay as it is", () => {
    expect(forms.filter((f) => /\bmethod="get"/.test(f.tag)).map((f) => f.file)).toEqual([
      join("app", "(shell)", "records", "page.tsx"),
    ]);
  });
});
