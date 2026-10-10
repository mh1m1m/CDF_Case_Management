/**
 * Error-event scrubber for Sentry (CDF-64). Pure: no Sentry dependency, no I/O, no mutation.
 *
 * Intended for the SDK's `beforeSend`, `beforeSendTransaction` and `beforeBreadcrumb` hooks once
 * the SDK is wired (a later story; see docs/observability/SENTRY_PLAN.md). Data minimisation
 * (CLAUDE.md §4, §11; protocol §83): no reporter identity, case narrative, evidence content or
 * name, report reference or secret, credential, cookie, request body, IP address or personal
 * identifier ever leaves the process. Values are replaced by `[REDACTED:<kind>]` markers rather
 * than hashed, so nothing derived from a secret leaves either.
 *
 * The scrubber is deny-by-default where it cannot know the shape (request bodies, cookies, the
 * user object, frame variables) and pattern-based for free text (messages, exception values,
 * breadcrumb messages, tags, extra, contexts). It is idempotent: scrubbing a scrubbed event
 * returns an identical event.
 *
 * PRODUCTION_SUBSTITUTION_REQUIRED: Sentry is a prototype observability processor. Production
 * uses the approved SOC/observability platform (architecture/PRODUCTION_MAPPING.md); this
 * scrubber is designed to sit in front of either.
 */

const MAX_DEPTH = 12;

export const REDACTED = (kind: string): string => `[REDACTED:${kind}]`;

/**
 * Keys whose values are removed wherever they appear in free-form data (extra, contexts, tags,
 * breadcrumb data, span data, mechanism data). Compared after lower-casing and dropping
 * everything but letters and digits, so `subject_description`, `subjectDescription` and
 * `Subject-Description` all match.
 */
const DENIED_KEYS: ReadonlySet<string> = new Set([
  // Narrative and case content (Arabic or English).
  "description",
  "subjectdescription",
  "summary",
  "body",
  "narrative",
  "details",
  "detail",
  "where",
  "hint",
  "content",
  "message",
  "text",
  "reason",
  "justification",
  "declaration",
  "statement",
  "transcript",
  "note",
  "notes",
  "comment",
  "comments",
  "title",
  "subject",
  "location",
  "incidentdate",
  "allegation",
  "answers",
  "formdata",
  "data",
  // Identity and personal identifiers.
  "fullname",
  "firstname",
  "lastname",
  "displayname",
  "username",
  "reportername",
  "witnessname",
  "identity",
  "protectedidentity",
  "reporter",
  "email",
  "phone",
  "mobile",
  "preferredcontact",
  "nationalid",
  "iqama",
  "address",
  "ip",
  "ipaddress",
  "clientip",
  "remoteaddr",
  "xforwardedfor",
  "xrealip",
  "user",
  // Report access and evidence.
  "reportref",
  "reportid",
  "secret",
  "filename",
  "originalfilename",
  "objectkey",
  // Request material.
  "query",
  "querystring",
  "headers",
  "cookies",
]);

/** Substrings that mark a key as credential material wherever they appear in the key. */
const DENIED_KEY_FRAGMENTS: readonly string[] = [
  "password",
  "passwd",
  "secret",
  "token",
  "cookie",
  "authorization",
  "apikey",
  "session",
  "pepper",
  "salt",
  "privatekey",
  "servicerole",
  "dsn",
  "jwt",
];

/** Request headers that carry no personal data and may be kept. Everything else is dropped. */
const ALLOWED_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "accept-language",
  "content-length",
  "content-type",
  "x-correlation-id",
]);

const normaliseKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");

export function isDeniedKey(key: string): boolean {
  const k = normaliseKey(key);
  return DENIED_KEYS.has(k) || DENIED_KEY_FRAGMENTS.some((f) => k.includes(f));
}

const ARABIC = String.raw`\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFC`;
const ARABIC_RUN = new RegExp(
  String.raw`[${ARABIC}]+(?:[\s\d.,\u060C\u061B:!?\u061F()\u00AB\u00BB"'-]+[${ARABIC}]+)*`,
  "gu",
);

const EMAIL_RULE = [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, REDACTED("email")] as const;

/**
 * Free-text patterns, applied in order. Earlier patterns must run first where a later one would
 * match a substring (credentials before emails, national IDs before generic digit runs).
 * None of the replacement markers matches any pattern, which keeps the scrubber idempotent.
 */
const STRING_RULES: readonly (readonly [RegExp, string | ((...m: string[]) => string)])[] = [
  // PostgreSQL error details echo row and key values (narrative included).
  [/\bFailing row contains \(.*\)/g, `Failing row contains (${REDACTED("db-row")})`],
  [/\b(Key \([^)]*\)=)\(.*\)/g, (_m, key) => `${key}(${REDACTED("db-row")})`],
  // Bearer / Basic credentials and JWTs.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, (_m, scheme) => `${scheme} ${REDACTED("credential")}`],
  [/\bsb_secret_[A-Za-z0-9_-]+/g, REDACTED("credential")],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, REDACTED("jwt")],
  // key=value and key: value pairs for credential-like keys inside free text.
  [
    /\b([A-Za-z_-]*(?:password|passwd|secret|token|apikey|api_key|authorization|cookie|session|pepper)[A-Za-z_-]*)("?\s*[=:]\s*)(?!\[REDACTED:)("[^"]*"|'[^']*'|[^\s&,;"']+)/gi,
    (_m, key, sep) => `${key}${sep}${REDACTED("credential")}`,
  ],
  // URL query strings and fragments: keep the path, drop everything after ? or #.
  [/\?(?!\[REDACTED:)[^\s"'<>]*=[^\s"'<>]*/g, `?${REDACTED("query")}`],
  // Reporter follow-up secret (grouped or compact) and report reference (§23).
  // The portal's normalisers accept any case, O/I/L look-alikes and any separator, so match the
  // same shapes: 5 groups of 4 with one consistent separator, compact or spaced, and the
  // reference with or without its hyphen.
  [/\b[0-9A-Z]{4}([^\sA-Z0-9])[0-9A-Z]{4}(?:\1[0-9A-Z]{4}){3}\b/gi, REDACTED("report-secret")],
  // Compact, spaced, or with mixed or multi-character separators (`ABCD - EFGH JKMN-…`), which the
  // secret normaliser also accepts because it drops every non-alphanumeric character. Groups are
  // either all joined or all separated, so a UUID (8-4-4-4-12) does not match. Only when
  // the run has a digit or is upper case, so ordinary English (five four-letter words, a
  // 20-letter identifier) is left alone.
  [
    /\b(?:[0-9A-Z]{20}|[0-9A-Z]{4}(?:[^0-9A-Z\r\n]{1,3}[0-9A-Z]{4}){4})\b/gi,
    (m) => (/\d/.test(m) || m === m.toUpperCase() ? REDACTED("report-secret") : m),
  ],
  // Report reference with or without a separator, including `WB 0123…` and `WB - 0123…`.
  [
    /\bWB[^0-9A-Z\r\n]{0,3}[0-9A-Z]{12}\b/gi,
    (m) => (/\d/.test(m) || m === m.toUpperCase() ? REDACTED("report-ref") : m),
  ],
  EMAIL_RULE,
  // Long hex digests (HMACs, hashes of secrets).
  [/\b[0-9a-f]{40,}\b/gi, REDACTED("digest")],
  // IPv4, then IPv6 (needs '::' or eight groups so clock times do not match).
  [/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g, REDACTED("ip")],
  [/(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])/gi, REDACTED("ip")],
  [/(?<![\w:])(?=[0-9a-f:]*::)(?:[0-9a-f]{1,4})?(?::[0-9a-f]{0,4}){2,7}(?![\w:])/gi, REDACTED("ip")],
  // Saudi national ID / Iqama: 10 digits starting 1 (citizen) or 2 (resident).
  [/(?<![\w-])[12]\d{9}(?![\w-])/g, REDACTED("national-id")],
  // Phone numbers: international (+ or 00) and Saudi mobile (05x), with optional separators.
  [/(?<![\w-])(?:\+|00)\d{1,3}[\s-]?\d(?:[\s-]?\d){6,13}(?![\w-])/g, REDACTED("phone")],
  [/(?<![\w-])05\d(?:[\s-]?\d){7}(?![\w-])/g, REDACTED("phone")],
  [/(?<![\w-])966[\s-]?5\d(?:[\s-]?\d){7}(?![\w-])/g, REDACTED("phone")],
  // Any other run of 9+ digits (account numbers, unformatted identifiers).
  [/(?<![\w-])\d{9,}(?![\w-])/g, REDACTED("number")],
  // Arabic script: application error text is English, so Arabic in an event is user content.
  [ARABIC_RUN, REDACTED("text")],
];

/**
 * For pnpm store path segments (see scrubCodeLocation): the email rule only spares `name@1.2.3`
 * version pairs, whose "domain" is all digits and dots. A real address inside a crafted path is
 * still removed.
 */
const STRING_RULES_FOR_PNPM_SEGMENT: typeof STRING_RULES = STRING_RULES.map((rule) =>
  rule === EMAIL_RULE
    ? ([EMAIL_RULE[0], (m: string) => (/@\d+(?:\.\d+)+$/.test(m) ? m : REDACTED("email"))] as const)
    : rule,
);

/** Removes personal data and credentials from one free-text string. */
export function scrubString(input: string, rules: typeof STRING_RULES = STRING_RULES): string {
  let out = input;
  for (const [pattern, replacement] of rules) {
    out =
      typeof replacement === "string" ? out.replace(pattern, replacement) : out.replace(pattern, replacement);
  }
  return out;
}

type Json = unknown;

function scrubValue(value: Json, depth: number, seen: WeakSet<object>): Json {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return REDACTED("depth");
  if (seen.has(value)) return REDACTED("cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1, seen));
    const out: Record<string, Json> = {};
    for (const [key, v] of Object.entries(value)) {
      // A key that itself carries personal data (an email used as a map key) is dropped.
      if (scrubString(key) !== key) continue;
      out[key] = isDeniedKey(key) ? REDACTED("field") : scrubValue(v, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** Scrubs a free-form map (extra, contexts, tags, breadcrumb or span data). */
export function scrubData<T>(value: T): T {
  return scrubValue(value, 0, new WeakSet()) as T;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const str = (v: unknown): unknown => (typeof v === "string" ? scrubString(v) : v);

/** URL without query string, fragment or credentials; path segments are pattern-scrubbed. */
function scrubUrl(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const withoutQuery = v.replace(/[?#].*$/s, "").replace(/\/\/[^/@\s]*@/, "//");
  return scrubString(withoutQuery);
}

function scrubRequest(request: unknown): unknown {
  if (!isRecord(request)) return request;
  const out: Record<string, unknown> = {};
  if ("method" in request) out.method = str(request.method);
  if ("url" in request) out.url = scrubUrl(request.url);
  if (isRecord(request.headers)) {
    const headers: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (ALLOWED_HEADERS.has(name.toLowerCase())) headers[name] = str(value);
    }
    out.headers = headers;
  }
  // data, cookies, query_string, env and anything else are dropped (deny by default).
  for (const key of ["data", "cookies", "query_string", "env"]) {
    if (key in request) out[key] = REDACTED("field");
  }
  return out;
}

/**
 * Frame fields that locate code. They are still pattern-scrubbed: the Node stack parser reads
 * frames from `error.stack`, which starts with the error message, so a message that echoes user
 * input containing "\n    at …" (Postgres does, for invalid uuid syntax) produces fake frames
 * whose function, file and module names are user text (CDF-62 review of CDF-81).
 */
const CODE_LOCATION_FRAME_KEYS: ReadonlySet<string> = new Set([
  "filename",
  "abs_path",
  "module",
  "function",
  "package",
]);

/**
 * A pnpm store directory name, e.g. `node_modules/.pnpm/@sentry+nextjs@10.75.3_@opentelemetry+api@1.9.1`.
 * Its `name@version` pairs look like email addresses, which would mangle real frame paths and
 * break grouping, so inside it the email rule spares those pairs; every other rule applies. The
 * character class excludes spaces, Arabic and other free text.
 */
const PNPM_STORE_SEGMENT = /(node_modules\/\.pnpm\/[A-Za-z0-9@+._-]+)/;

function scrubCodeLocation(value: unknown): unknown {
  if (value !== null && typeof value === "object") return REDACTED("field");
  if (typeof value !== "string") return value;
  return value
    .split(PNPM_STORE_SEGMENT)
    .map((part, i) => (i % 2 === 1 ? scrubString(part, STRING_RULES_FOR_PNPM_SEGMENT) : scrubString(part)))
    .join("");
}

function scrubFrame(frame: unknown): unknown {
  if (!isRecord(frame)) return frame;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frame)) {
    if (key === "vars") out[key] = REDACTED("field");
    else if (CODE_LOCATION_FRAME_KEYS.has(key)) out[key] = scrubCodeLocation(value);
    else if (Array.isArray(value)) out[key] = value.map(str);
    else out[key] = str(value);
  }
  return out;
}

function scrubStacktrace(stacktrace: unknown): unknown {
  if (!isRecord(stacktrace)) return stacktrace;
  return {
    ...stacktrace,
    ...(Array.isArray(stacktrace.frames) ? { frames: stacktrace.frames.map(scrubFrame) } : {}),
  };
}

function scrubException(exception: unknown): unknown {
  if (!isRecord(exception)) return exception;
  const out: Record<string, unknown> = { ...exception };
  if ("value" in out) out.value = str(out.value);
  if ("type" in out) out.type = str(out.type);
  if ("stacktrace" in out) out.stacktrace = scrubStacktrace(out.stacktrace);
  if (isRecord(out.mechanism)) {
    out.mechanism = {
      ...out.mechanism,
      ...("data" in out.mechanism ? { data: scrubData(out.mechanism.data) } : {}),
    };
  }
  return out;
}

function scrubValuesContainer(container: unknown, fn: (v: unknown) => unknown): unknown {
  if (Array.isArray(container)) return container.map(fn);
  if (isRecord(container) && Array.isArray(container.values)) {
    return { ...container, values: container.values.map(fn) };
  }
  return container;
}

function scrubLogEntry(entry: unknown): unknown {
  if (typeof entry === "string") return scrubString(entry);
  if (!isRecord(entry)) return entry;
  const out: Record<string, unknown> = { ...entry };
  if ("message" in out) out.message = str(out.message);
  if ("formatted" in out) out.formatted = str(out.formatted);
  // Format parameters are arbitrary runtime values; never send them.
  if ("params" in out) out.params = REDACTED("field");
  return out;
}

const BREADCRUMB_URL_KEYS: ReadonlySet<string> = new Set(["url", "from", "to"]);
const BREADCRUMB_DATA_KEYS: ReadonlySet<string> = new Set([
  "method",
  "status_code",
  "http.method",
  "http.request.method",
  "http.response.status_code",
]);

/**
 * Standard SDK contexts and the fields of each that are kept. Any other context, or any other
 * field, is dropped: English names and narrative cannot be recognised by pattern, so free-form
 * contexts are deny-by-default.
 */
const CONTEXT_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  os: new Set(["type", "name", "version", "build", "kernel_version"]),
  runtime: new Set(["type", "name", "version"]),
  browser: new Set(["type", "name", "version"]),
  device: new Set(["type", "family", "model", "arch", "memory_size", "processor_count", "cpu_description"]),
  app: new Set([
    "type",
    "app_name",
    "app_version",
    "app_build",
    "app_identifier",
    "app_start_time",
    "app_memory",
  ]),
  trace: new Set(["type", "trace_id", "span_id", "parent_span_id", "op", "status", "origin"]),
  culture: new Set(["type", "locale", "timezone"]),
  cloud_resource: new Set([
    "type",
    "cloud.provider",
    "cloud.platform",
    "cloud.region",
    "cloud.availability_zone",
  ]),
  response: new Set(["type", "status_code"]),
};

/**
 * Keys allowed in `extra` and `tags`: the fixed list the plan permits (correlation ID, error
 * kind, route template, locale) plus the SDK's own technical tags. Everything else is dropped.
 */
const EXTRA_KEYS: ReadonlySet<string> = new Set([
  "correlationId",
  "correlation_id",
  "errorKind",
  "error_kind",
  "kind",
  "route",
]);
const TAG_KEYS: ReadonlySet<string> = new Set([
  ...EXTRA_KEYS,
  // The app name set once in the SDK's initial scope (CDF-81).
  "app",
  "locale",
  "runtime",
  "runtime.name",
  "handled",
  "mechanism",
  "level",
  "transaction",
  "url",
  "environment",
  "release",
  "server_name",
  "os",
  "os.name",
  "browser",
  "browser.name",
  "device",
]);

/**
 * Allow-listed keys keep scalar values only. An object or array under an allowed key (for
 * example `kind: { witness: "…" }`) could carry user content that no pattern recognises, so it is
 * replaced rather than walked.
 */
function scalar(key: string, v: unknown): unknown {
  if (typeof v === "string") return key === "url" ? scrubUrl(v) : scrubString(v);
  if (typeof v === "number" || typeof v === "boolean" || v === null || v === undefined) return v;
  return REDACTED("field");
}

function pick(value: unknown, allowed: ReadonlySet<string>): unknown {
  if (!isRecord(value)) return REDACTED("field");
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!allowed.has(key)) continue;
    out[key] = scalar(key, v);
  }
  return out;
}

function scrubContexts(contexts: unknown): unknown {
  if (!isRecord(contexts)) return REDACTED("field");
  const out: Record<string, unknown> = {};
  for (const [name, context] of Object.entries(contexts)) {
    const fields = CONTEXT_FIELDS[name];
    if (fields) out[name] = pick(context, fields);
  }
  return out;
}

/**
 * Breadcrumb categories whose `message` is SDK-generated technical text (a URL or route). Every
 * other category's message is replaced: English names and narrative cannot be recognised by
 * pattern, and a breadcrumb message is never needed to group or reproduce an error.
 */
const BREADCRUMB_MESSAGE_CATEGORIES: ReadonlySet<string> = new Set(["navigation", "http", "fetch", "xhr"]);

/** Scrubs one breadcrumb. Usable directly as the SDK's `beforeBreadcrumb`. */
export function scrubBreadcrumb<T>(breadcrumb: T): T {
  if (!isRecord(breadcrumb)) return breadcrumb;
  const out: Record<string, unknown> = { ...breadcrumb };
  if ("message" in out) {
    const technical = typeof out.category === "string" && BREADCRUMB_MESSAGE_CATEGORIES.has(out.category);
    out.message = technical ? scrubUrl(out.message) : REDACTED("text");
  }
  if ("data" in out) {
    const data = isRecord(out.data) ? { ...out.data } : out.data;
    if (isRecord(data)) {
      // Allow-list: navigation and HTTP metadata only. URLs keep their path only.
      const kept: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        if (BREADCRUMB_URL_KEYS.has(key)) kept[key] = scrubUrl(value);
        else if (BREADCRUMB_DATA_KEYS.has(key)) kept[key] = scrubData(value);
      }
      out.data = kept;
    } else {
      out.data = scrubData(data);
    }
  }
  return out as T;
}

function scrubSpan(span: unknown): unknown {
  if (!isRecord(span)) return span;
  const out: Record<string, unknown> = { ...span };
  if ("description" in out) out.description = str(out.description);
  if ("data" in out) out.data = scrubData(out.data);
  if ("tags" in out) out.tags = scrubData(out.tags);
  return out;
}

/** Top-level keys that are SDK or build metadata, never user data; kept as they are. Unknown keys are dropped. */
const PASSTHROUGH = new Set([
  "event_id",
  "timestamp",
  "start_timestamp",
  "level",
  "platform",
  "logger",
  "release",
  "dist",
  "environment",
  "server_name",
  "sdk",
  "modules",
  "type",
  "debug_meta",
]);

/**
 * Scrubs a Sentry event (error or transaction). Returns a new object; the input is not changed.
 * Usable directly as `beforeSend` / `beforeSendTransaction`: `beforeSend: (e) => scrubSentryEvent(e)`.
 */
export function scrubSentryEvent<T>(event: T): T {
  if (!isRecord(event)) return event;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    switch (key) {
      case "user":
        // The user object (id, email, username, ip_address, geo) is never sent.
        break;
      case "request":
        out.request = scrubRequest(value);
        break;
      case "message":
      case "logentry":
        out[key] = scrubLogEntry(value);
        break;
      case "exception":
        out.exception = scrubValuesContainer(value, scrubException);
        break;
      case "threads":
        out.threads = scrubValuesContainer(value, (t) =>
          isRecord(t) && "stacktrace" in t ? { ...t, stacktrace: scrubStacktrace(t.stacktrace) } : t,
        );
        break;
      case "breadcrumbs":
        out.breadcrumbs = scrubValuesContainer(value, scrubBreadcrumb);
        break;
      case "spans":
        out.spans = Array.isArray(value) ? value.map(scrubSpan) : value;
        break;
      case "transaction":
        out.transaction = scrubUrl(value);
        break;
      case "fingerprint":
        out.fingerprint = Array.isArray(value) ? value.map(str) : value;
        break;
      case "contexts":
        out.contexts = scrubContexts(value);
        break;
      case "extra":
        out.extra = pick(value, EXTRA_KEYS);
        break;
      case "tags":
        out.tags = pick(value, TAG_KEYS);
        break;
      case "measurements":
        out.measurements = scrubData(value);
        break;
      default:
        // SDK metadata passes; anything else (including sdkProcessingMetadata, which can hold the
        // raw request) is dropped rather than trusted.
        if (PASSTHROUGH.has(key)) out[key] = value;
    }
  }
  return out as T;
}
