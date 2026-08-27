/**
 * Detects a standalone `any` type token in a rendered type (degraded
 * type-checker mode). The negative lookahead excludes a property *key* named
 * `any` (`{ any: string }` / `{ any?: T }`) — a key is always followed by `:` /
 * `?:`, a real `any` type never is. String-literal type members (`kind: "any"`,
 * `"any" | "all"`) are removed via {@link STRING_LITERAL_SPAN_RE} before this
 * runs, so a discriminant literal `"any"` no longer degrades the whole type.
 */
const ANY_TOKEN_RE = /\bany\b(?!\s*(?:\?\s*)?:)/u;

/**
 * String / template literal *type* spans in a rendered type. Their text is data,
 * not a type token, so an `any` inside one (`kind: "any"`) must not trip
 * degraded-mode detection; callers strip these before testing {@link ANY_TOKEN_RE}.
 */
const STRING_LITERAL_SPAN_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/gu;

/**
 * True when a rendered type is `any`-degraded — the checker fell back to `any`
 * somewhere inside it, typical when running against a stand-alone fixture with no
 * tsconfig wiring. String-literal type members are stripped first so a discriminant
 * literal (`kind: "any"`) does not trip it. Callers emit `unknown` rather than the
 * degraded render.
 */
const isAnyDegraded = (rendered: string): boolean => ANY_TOKEN_RE.test(rendered.replaceAll(STRING_LITERAL_SPAN_RE, ""));

export default isAnyDegraded;
