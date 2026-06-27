/**
 * Strict allowlist for a primitive-literal source text that is safe to both (a)
 * map to a TS literal type during emission and (b) inline into a `===` comparison
 * inside a compiled validator. Accepts a double-quoted string with no embedded
 * `"`/backslash, a single-quoted string with no embedded `'`/backslash, an
 * integer/decimal (optional leading `-`), or one of `true` / `false` / `null`.
 *
 * Anything fancier (escapes, exponents, a referenced constant) is rejected so
 * neither consumer ever emits an unsafe expression. Shared by `emit.ts`
 * (`v.literal(...)` type emission) and `compile-validator.ts` (AOT inlining) so
 * the two safety judgments can't drift apart.
 */
const LITERAL_VALUE_RE = /^(?:"[^"\\]*"|'[^'\\]*'|-?\d+(?:\.\d+)?|true|false|null)$/u;

export default LITERAL_VALUE_RE;
