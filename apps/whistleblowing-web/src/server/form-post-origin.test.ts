// UX-002: only a same-origin form navigation that arrives with `Origin: null` gets its own origin back.
// Everything else reaches Next.js's Server Action origin check unchanged.
import { describe, expect, it } from "vitest";
import { restoredFormPostOrigin } from "./form-post-origin";

const sameOriginFormPost = {
  origin: "null",
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "navigate",
  host: "127.0.0.1:3101",
};

const request = (
  headers: Record<string, string>,
  over: Partial<{ method: string; pathname: string }> = {},
) => ({
  method: over.method ?? "POST",
  pathname: over.pathname ?? "/report",
  protocol: "http:",
  headers: new Headers(headers),
});

describe("restoredFormPostOrigin", () => {
  it("restores the request's own origin for a same-origin native form POST", () => {
    expect(restoredFormPostOrigin(request(sameOriginFormPost))).toBe("http://127.0.0.1:3101");
    expect(restoredFormPostOrigin(request(sameOriginFormPost, { pathname: "/follow-up" }))).toBe(
      "http://127.0.0.1:3101",
    );
  });

  it("uses the forwarded host first, as Next.js does", () => {
    expect(
      restoredFormPostOrigin(
        request({ ...sameOriginFormPost, "x-forwarded-host": "portal.example.test, edge" }),
      ),
    ).toBe("http://portal.example.test");
  });

  it.each([
    ["a cross-site post", { "sec-fetch-site": "cross-site" }],
    ["a same-site post from another origin", { "sec-fetch-site": "same-site" }],
    ["a user-initiated or unknown-site post", { "sec-fetch-site": "none" }],
    ["a fetch, not a navigation", { "sec-fetch-mode": "cors" }],
    ["a real Origin header", { origin: "http://attacker.example.test" }],
    ["no Origin header", { origin: "" }],
  ])("leaves %s unchanged", (_label, over) => {
    const headers: Record<string, string> = { ...sameOriginFormPost, ...over };
    if (headers.origin === "") delete headers.origin;
    expect(restoredFormPostOrigin(request(headers))).toBeNull();
  });

  it("leaves requests without Fetch Metadata, other methods and other paths unchanged", () => {
    const { "sec-fetch-site": _site, "sec-fetch-mode": _mode, ...noMetadata } = sameOriginFormPost;
    expect(restoredFormPostOrigin(request(noMetadata))).toBeNull();
    expect(restoredFormPostOrigin(request(sameOriginFormPost, { method: "GET" }))).toBeNull();
    expect(
      restoredFormPostOrigin(request(sameOriginFormPost, { pathname: "/report/attachments" })),
    ).toBeNull();
    expect(restoredFormPostOrigin(request(sameOriginFormPost, { pathname: "/" }))).toBeNull();
  });
});
