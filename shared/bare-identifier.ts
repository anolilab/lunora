/**
 * Canonical bare-SQL-identifier test, shared by every store that splices a
 * table/column name into raw SQL.
 *
 * An identifier cannot be bound as a parameter, so it is interpolated into the
 * statement — which makes it the one injection surface these stores have. Like
 * `shared/quote-identifier.ts`, this is a security-relevant primitive and must
 * have exactly ONE definition rather than byte-identical copies that can drift.
 * It exists because there were three: `@lunora/ai/rag`, `@lunora/notify` and
 * `@lunora/hyperdrive` each carried their own regex.
 *
 * The allowlist is deliberately narrower than what SQL permits — no quoting, no
 * schema qualification, no Unicode. A caller who needs one of those should be
 * told so at construction rather than have their input concatenated in.
 *
 * Two properties are load-bearing and easy to lose in a rewrite:
 *
 * - `\w` is ASCII-only (`[A-Za-z0-9_]`), so a homoglyph or full-width character
 *   is rejected rather than reaching the statement.
 * - `$` carries no `m` flag, so it anchors at end-of-input only. With `m` it
 *   would also match before a trailing newline, and `"users\nDROP TABLE x"`
 *   would pass.
 *
 * This returns a boolean rather than throwing: consumers disagree about the
 * error type (`@lunora/notify` raises a coded `LunoraError`, the others a
 * `TypeError`) and about how to name the offending option. Unifying the check
 * without unifying the message is the point.
 *
 * Deliberately **not** a package: the consumers sit on different tiers with no
 * common lower-level home, so each imports this file by relative path and the
 * bundler (packem/rollup) inlines it — no runtime dependency edge, duplicated
 * only in emitted output. Keep it genuinely zero-dependency (relative/built-in
 * imports only) or inlining breaks. Consumers must drop `outDir`/`rootDir` from
 * their `tsconfig.json` (a set `rootDir` raises TS6059 for this out-of-package
 * file under `tsc --noEmit`).
 * @param value The candidate identifier.
 * @returns `true` when `value` is `[A-Za-z_][A-Za-z0-9_]*` and nothing else.
 */
export const isBareIdentifier = (value: string): boolean => /^[A-Z_]\w*$/i.test(value);
