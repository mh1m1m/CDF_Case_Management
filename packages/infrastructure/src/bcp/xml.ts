// A minimal XML tokenizer for the SpreadsheetML parts the BCP reader needs (ADR-034 D3). It refuses any DTD or entity
// declaration, decodes only the five predefined entities and numeric character references, and never resolves
// anything external. Element and attribute names are reduced to their local names (namespace prefixes dropped).
// PRODUCTION_SUBSTITUTION_REQUIRED: a vetted workbook reader in the CDF runtime.

export class XmlRejected extends Error {
  override name = "XmlRejected";
  constructor(readonly code: "DTD" | "ENTITY" | "MALFORMED" | "TOO_DEEP") {
    super(`XML_REJECTED:${code}`);
  }
}

export type XmlEvent =
  | { type: "open"; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { type: "close"; name: string }
  | { type: "text"; value: string };

const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*/;
const MAX_DEPTH = 64;

function localName(qualified: string): string {
  const i = qualified.indexOf(":");
  return i < 0 ? qualified : qualified.slice(i + 1);
}

/** Decodes the predefined entities and numeric references; any other reference is refused. */
export function decodeText(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&([^;&\s]{1,10});/g, (_, ref: string) => {
    if (ref in PREDEFINED) return PREDEFINED[ref]!;
    const m = /^#(?:x([0-9A-Fa-f]{1,6})|([0-9]{1,7}))$/.exec(ref);
    if (!m) throw new XmlRejected("ENTITY");
    const code = m[1] !== undefined ? parseInt(m[1], 16) : parseInt(m[2]!, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
      throw new XmlRejected("MALFORMED");
    return String.fromCodePoint(code);
  });
}

function checkNoStrayAmpersand(raw: string) {
  // After decoding, a bare '&' in the source (not starting a reference) is malformed XML.
  if (/&(?![^;&\s]{1,10};)/.test(raw)) throw new XmlRejected("MALFORMED");
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /\s*([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
  let at = 0;
  while (at < source.length) {
    if (/^\s*$/.test(source.slice(at))) break;
    re.lastIndex = at;
    const m = re.exec(source);
    if (!m) throw new XmlRejected("MALFORMED");
    const raw = m[2] ?? m[3] ?? "";
    checkNoStrayAmpersand(raw);
    attrs[localName(m[1]!)] = decodeText(raw);
    at = re.lastIndex;
  }
  return attrs;
}

/** The '>' that ends the tag opened at `from`, skipping quoted attribute values (which may hold '>'). */
function tagEnd(xml: string, from: number): number {
  let quote = "";
  for (let i = from; i < xml.length; i++) {
    const c = xml[i]!;
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    } else if (c === "<") {
      return -1;
    }
  }
  return -1;
}

/** Tokenizes a document into open, close and text events. Comments, processing instructions and the XML
 *  declaration are skipped; CDATA becomes text; a DOCTYPE or any other markup declaration is refused. */
export function* tokenize(xml: string): Generator<XmlEvent> {
  if (/<!DOCTYPE|<!ENTITY|<!ELEMENT|<!ATTLIST|<!NOTATION/i.test(xml)) throw new XmlRejected("DTD");
  const stack: string[] = [];
  let at = 0;
  while (at < xml.length) {
    const lt = xml.indexOf("<", at);
    const textEnd = lt < 0 ? xml.length : lt;
    if (textEnd > at) {
      const raw = xml.slice(at, textEnd);
      if (stack.length === 0) {
        if (!/^\s*$/.test(raw)) throw new XmlRejected("MALFORMED");
      } else {
        checkNoStrayAmpersand(raw);
        yield { type: "text", value: decodeText(raw) };
      }
    }
    if (lt < 0) break;
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end < 0) throw new XmlRejected("MALFORMED");
      at = end + 2;
    } else if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) throw new XmlRejected("MALFORMED");
      at = end + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0 || stack.length === 0) throw new XmlRejected("MALFORMED");
      yield { type: "text", value: xml.slice(lt + 9, end) };
      at = end + 3;
    } else if (xml.startsWith("<!", lt)) {
      throw new XmlRejected("DTD");
    } else if (xml.startsWith("</", lt)) {
      const end = xml.indexOf(">", lt + 2);
      if (end < 0) throw new XmlRejected("MALFORMED");
      const name = xml.slice(lt + 2, end).trim();
      if (!NAME.test(name) || stack.pop() !== name) throw new XmlRejected("MALFORMED");
      yield { type: "close", name: localName(name) };
      at = end + 1;
    } else {
      const end = tagEnd(xml, lt + 1);
      if (end < 0) throw new XmlRejected("MALFORMED");
      let body = xml.slice(lt + 1, end);
      const selfClosing = body.endsWith("/");
      if (selfClosing) body = body.slice(0, -1);
      const m = NAME.exec(body);
      if (!m) throw new XmlRejected("MALFORMED");
      const name = m[0];
      const attrs = parseAttributes(body.slice(name.length));
      yield { type: "open", name: localName(name), attrs, selfClosing };
      if (selfClosing) {
        yield { type: "close", name: localName(name) };
      } else {
        stack.push(name);
        if (stack.length > MAX_DEPTH) throw new XmlRejected("TOO_DEEP");
      }
      at = end + 1;
    }
  }
  if (stack.length !== 0) throw new XmlRejected("MALFORMED");
}
