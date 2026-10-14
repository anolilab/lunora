/**
 * Canonical SQLite JSON-path object-label quoter — the JSON-path twin of
 * `shared/quote-identifier.ts`, and needed for the same reason: two modules of
 * the DO store splice a field name into a `json_extract` path, and byte-identical
 * copies of the escape rule are exactly what drifts. They already had, in
 * opposite directions — `do-sql.ts` escaped the field for the SQL string literal
 * and not for the path at all, while `introspect.ts` doubled `"` as if it were a
 * SQL identifier. Both mis-address the document.
 *
 * SQLite reads a bare `.label` up to the next `.` or `[`, so a field named `a.b`
 * in `$.a.b` resolves as the *nested* key `b` under `a` — a different value, or
 * none, with nothing raised. `$."a.b"` addresses the real key. Inside the quoted
 * form SQLite applies JSON string escapes, so `\` and `"` must BOTH be escaped
 * (`\\` / `\"`); an unescaped `\` silently yields NULL, and the `""` doubling
 * that quotes a SQL identifier is not a JSON-path escape at all.
 *
 * Quoting is applied only when the bare form would misparse. That is not
 * cosmetic: these paths are the expression text of the DO store's `CREATE INDEX`
 * statements, and SQLite matches an expression index to a query by comparing that
 * text. Quoting unconditionally would leave every index already on disk unmatched
 * and silently unused, degrading each affected query to a scan with nothing
 * failing. The bare shape below is deliberately the same identifier shape
 * `@lunora/codegen`'s `parseValidatorObject` (`FIELD_NAME_RE` in
 * `parse-validator.ts`) already enforces on every schema-declared field, so every
 * path this store has ever emitted keeps its exact spelling.
 *
 * Callers embedding the result in a SQL *string literal* still owe it the `'`
 * doubling on top; callers binding it as a parameter do not.
 *
 * Like `shared/quote-identifier.ts` this is deliberately **not** a package —
 * consumers import it by relative path and the bundler inlines it. Keep it
 * genuinely zero-dependency.
 */
const BARE_JSON_PATH_LABEL = /^[A-Za-z_$][\w$]*$/u;

export const jsonPathSegment = (field: string): string =>
    BARE_JSON_PATH_LABEL.test(field) ? field : `"${field.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`)}"`;
