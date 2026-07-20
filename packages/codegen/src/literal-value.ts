/**
 * Strict allowlist for a primitive-literal source text that is safe to both (a)
 * map to a TS literal type during emission and (b) inline into a `===` comparison
 * inside a compiled validator. Accepts a **canonical JSON double-quoted string**
 * (the `parse-validator`/`resolve-package-extension` paths always render string
 * literals via `JSON.stringify`, so `\"`, `\\`, `\n`, `\uXXXX`, … are expected and
 * safe to splice back out — the only break-out characters, `"` and `\`, are only
 * ever matched by the escape alternative), a single-quoted string with no
 * embedded `'`/backslash, an integer/decimal (optional leading `-`), or one of
 * `true` / `false` / `null`.
 *
 * Anything fancier (exponents, a referenced constant, a non-canonical escape) is
 * rejected so neither consumer ever emits an unsafe expression. Shared by
 * `emit.ts` (`v.literal(...)` type emission) and `compile-validator.ts` (AOT
 * inlining) so the two safety judgments can't drift apart.
 */
// eslint-disable-next-line sonarjs/regex-complexity -- validated JSON-literal allowlist; splitting the alternation would risk a correctness gap
const LITERAL_VALUE_RE: RegExp = /^(?:"(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4}))*"|'[^'\\]*'|-?\d+(?:\.\d+)?|true|false|null)$/u;

export default LITERAL_VALUE_RE;
