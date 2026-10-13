// ADR-034 D3: the XML the reader parses refuses DTDs and entity declarations and resolves nothing external.
import { describe, expect, it } from "vitest";
import { XmlRejected, decodeText, tokenize, type XmlEvent } from "./xml";

const events = (xml: string): XmlEvent[] => [...tokenize(xml)];

function rejection(xml: string): string {
  try {
    events(xml);
  } catch (e) {
    if (e instanceof XmlRejected) return e.code;
    throw e;
  }
  return "ACCEPTED";
}

describe("XML tokenizer", () => {
  it("reads elements, attributes, text, CDATA and local names", () => {
    expect(
      events(
        `<?xml version="1.0" encoding="UTF-8"?><!-- c --><x:a xmlns:x="urn:x" r:id="rId1" b='a>b'><x:t xml:space="preserve"> 1 &amp; 2 </x:t><![CDATA[<raw>&amp;]]><e/></x:a>`,
      ),
    ).toEqual([
      { type: "open", name: "a", attrs: { x: "urn:x", id: "rId1", b: "a>b" }, selfClosing: false },
      { type: "open", name: "t", attrs: { space: "preserve" }, selfClosing: false },
      { type: "text", value: " 1 & 2 " },
      { type: "close", name: "t" },
      { type: "text", value: "<raw>&amp;" },
      { type: "open", name: "e", attrs: {}, selfClosing: true },
      { type: "close", name: "e" },
      { type: "close", name: "a" },
    ]);
  });

  it("decodes only the predefined entities and numeric references", () => {
    expect(decodeText("&lt;&gt;&amp;&quot;&apos;&#65;&#x645;")).toBe(`<>&"'Aم`);
    expect(() => decodeText("&nbsp;")).toThrow(XmlRejected);
    expect(() => decodeText("&#0;")).toThrow(XmlRejected);
    expect(() => decodeText("&#xD800;")).toThrow(XmlRejected);
    expect(rejection("<a>&ext;</a>")).toBe("ENTITY");
    expect(rejection(`<a b="&ext;"/>`)).toBe("ENTITY");
    expect(rejection("<a>fish & chips</a>")).toBe("MALFORMED");
  });

  it("refuses any DTD: billion laughs, external entities and parameter entities", () => {
    const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><a>&lol2;</a>`;
    const xxe = `<?xml version="1.0"?><!DOCTYPE a [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><a>&xxe;</a>`;
    const remote = `<!DOCTYPE a SYSTEM "http://example.test/a.dtd"><a/>`;
    const parameter = `<!doctype a [<!ENTITY % p SYSTEM "http://example.test/p">%p;]><a/>`;
    for (const xml of [laughs, xxe, remote, parameter]) expect(rejection(xml)).toBe("DTD");
    expect(rejection(`<a><!ELEMENT b ANY></a>`)).toBe("DTD");
    expect(rejection(`<a><!FOO></a>`)).toBe("DTD");
  });

  it("refuses malformed or over-deep documents", () => {
    for (const xml of [
      "<a>",
      "<a></b>",
      "<a><b></a></b>",
      "text<a/>",
      "<a b=c/>",
      "<a b='x' c/>",
      "<a>x",
      "<1a/>",
      "<a b='<'/>",
    ]) {
      expect(rejection(xml), xml).toBe("MALFORMED");
    }
    expect(rejection("<a>".repeat(65) + "</a>".repeat(65))).toBe("TOO_DEEP");
    expect(rejection("<a>".repeat(64) + "</a>".repeat(64))).toBe("ACCEPTED");
  });
});
