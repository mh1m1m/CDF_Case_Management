// UX-001 / UX-030 field rules of CDFCommandForm. The rule tested first: a secret is never echoed or re-rendered.
import { describe, expect, it } from "vitest";
import {
  clearSecretControls,
  echoValues,
  isSecretField,
  pruneUnchanged,
  restoreEcho,
  type CommandFormControl,
} from "./command-form-fields";

type Fake = CommandFormControl & { attrs?: Record<string, string> };

const text = (name: string, value = "", defaultValue = "", extra: Partial<Fake> = {}): Fake => ({
  name,
  type: "text",
  value,
  defaultValue,
  ...extra,
  getAttribute(attr: string) {
    return this.attrs?.[attr] ?? null;
  },
});
const choice = (
  type: "radio" | "checkbox",
  name: string,
  value: string,
  checked = false,
  defaultChecked = false,
) => ({ name, type, value, checked, defaultChecked }) as Fake;
const select = (name: string, options: [value: string, selected: boolean, defaultSelected: boolean][]) => {
  const opts = options.map(([value, selected, defaultSelected]) => ({ value, selected, defaultSelected }));
  return {
    name,
    type: "select-one",
    get value() {
      return opts.find((o) => o.selected)?.value ?? "";
    },
    set value(v: string) {
      for (const o of opts) o.selected = o.value === v;
    },
    options: opts,
  } as Fake;
};

function formData(entries: [string, string | Blob][]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

describe("secret fields are never echoed (CLAUDE.md §83, RC-01)", () => {
  it("recognises passwords, follow-up secrets, tokens, one-time codes and identity fields", () => {
    for (const name of [
      "password",
      "newPassword",
      "followUpSecret",
      "secret",
      "accessToken",
      "otp",
      "oneTimeCode",
      "reporterIdentity",
      "nationalId",
      "idNumber",
      "iqama",
      "passport",
    ]) {
      expect(isSecretField(name), name).toBe(true);
    }
    for (const name of [
      "reason",
      "title",
      "summary",
      "priority",
      "outcome",
      "hasConflict",
      "approve",
      "caseNumber",
    ]) {
      expect(isSecretField(name), name).toBe(false);
    }
  });

  it("leaves secrets, files and framework fields out of the echo", () => {
    const echoed = echoValues(
      formData([
        ["reason", "Synthetic reason typed by Investigator Beta"],
        ["password", "not-a-real-password"],
        ["followUpSecret", "not-a-real-secret"],
        ["reporterIdentity", "Employee Alpha"],
        ["$ACTION_ID_abc", "x"],
        ["file", new Blob(["synthetic"])],
        ["tag", "a"],
        ["tag", "b"],
      ]),
    );
    expect(echoed).toEqual({ reason: "Synthetic reason typed by Investigator Beta", tag: ["a", "b"] });
    expect(JSON.stringify(echoed)).not.toContain("not-a-real");
    expect(JSON.stringify(echoed)).not.toContain("Employee Alpha");
  });

  it("never writes a secret back into a form, even when one arrives in the echo", () => {
    const password = text("password", "", "", { type: "password" });
    const marked = text("witnessName", "", "", { attrs: { "data-cdf-secret": "" } });
    const secret = text("followUpSecret");
    const reason = text("reason");
    restoreEcho([password, marked, secret, reason], {
      password: "leaked",
      witnessName: "Witness Gamma",
      followUpSecret: "leaked",
      reason: "kept",
    });
    expect(password.value).toBe("");
    expect(marked.value).toBe("");
    expect(secret.value).toBe("");
    expect(reason.value).toBe("kept");
  });

  it("clears every secret control after a refusal and keeps everything else", () => {
    const password = text("password", "typed", "", { type: "password", autocomplete: "current-password" });
    const code = text("code", "123456", "", { autocomplete: "one-time-code" });
    const marked = text("witnessName", "Witness Gamma", "", { attrs: { "data-cdf-secret": "" } });
    const reason = text("reason", "Synthetic reason");
    const radio = choice("radio", "approve", "APPROVE", true);
    expect(clearSecretControls([password, code, marked, reason, radio])).toBe(3);
    expect([password.value, code.value, marked.value]).toEqual(["", "", ""]);
    expect(reason.value).toBe("Synthetic reason");
    expect(radio.checked).toBe(true);
  });
});

describe("restoring a refused submit made before hydration (UX-001)", () => {
  it("puts back text, the selected option, radio choices and unchecked boxes", () => {
    const reason = text("reason");
    const outcome = select("outcome", [
      ["", true, true],
      ["OPEN_CASE", false, false],
      ["REFER_OUT", false, false],
    ]);
    const yes = choice("radio", "hasConflict", "true", false, false);
    const no = choice("radio", "hasConflict", "false", true, true);
    const box = choice("checkbox", "isRestricted", "on", true, true);
    const hidden = { name: "expectedVersion", type: "hidden", value: "3" } as Fake;
    restoreEcho([reason, outcome, yes, no, box, hidden], {
      reason: "Synthetic",
      outcome: "REFER_OUT",
      hasConflict: "true",
      expectedVersion: "1",
    });
    expect(reason.value).toBe("Synthetic");
    expect(outcome.value).toBe("REFER_OUT");
    expect([yes.checked, no.checked]).toEqual([true, false]);
    expect(box.checked).toBe(false);
    expect(hidden.value).toBe("3");
  });

  it("leaves an unanswered radio group unanswered", () => {
    const a = choice("radio", "outcome", "ACCEPT");
    const b = choice("radio", "outcome", "RETURN");
    restoreEcho([a, b], { reason: "x" });
    expect([a.checked, b.checked]).toEqual([false, false]);
  });
});

describe("sending only what the user changed (UX-030)", () => {
  it("drops untouched fields and keeps edited ones", () => {
    const title = text("title", "Edited title", "Original title");
    const summary = text("summary", "Original summary", "Original summary");
    const priority = select("priority", [
      ["", false, false],
      ["LOW", false, true],
      ["HIGH", true, false],
    ]);
    const data = formData([
      ["title", "Edited title"],
      ["summary", "Original summary"],
      ["priority", "HIGH"],
    ]);
    const byName: Record<string, Fake[]> = { title: [title], summary: [summary], priority: [priority] };
    pruneUnchanged(data, ["title", "summary", "priority"], (n) => byName[n] ?? []);
    expect([...data.keys()]).toEqual(["title", "priority"]);
  });

  it("drops a select left on the value the page rendered, even when the page later shows another", () => {
    const priority = select("priority", [
      ["LOW", true, true],
      ["HIGH", false, false],
    ]);
    const data = formData([["priority", "LOW"]]);
    pruneUnchanged(data, ["priority"], () => [priority]);
    expect(data.has("priority")).toBe(false);
  });

  it("keeps a field it cannot find, so nothing is dropped by mistake", () => {
    const data = formData([["title", "x"]]);
    pruneUnchanged(data, ["title"], () => []);
    expect(data.get("title")).toBe("x");
  });
});
