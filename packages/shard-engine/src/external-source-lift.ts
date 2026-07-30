/**
 * The external-source id-lift and value normalization.
 *
 * Host-neutral on purpose, and shared: `@lunora/do`'s poll loop and
 * `@lunora/hyperdrive`'s `projectSourceRow` both lift rows through
 * {@link liftSourceId}, so the two paths can never drift in their
 * missing-id / non-scalar-id handling. That shared-contract role is exactly why
 * it lives in the engine rather than in the Durable Object package — an add-on
 * should not have to depend on `@lunora/do` to agree with it about what a row
 * means.
 */
import { LunoraError } from "@lunora/errors";

/**
 * Coerce a driver-native value that `stableStringify` can't represent (see
 * `shared/stable-key.ts`) into its JSON-safe form: a `Date` → its ISO string, a
 * `bigint` → its decimal string. Every other value passes through unchanged.
 *
 * node-pg / postgres-js / mysql2 return `timestamp`/`datetime` columns as JS
 * `Date` and `bigint`/`int8` columns as `bigint` — both throw a `TypeError` out of
 * `stableStringify` (used by the full-pull diff and the incremental content
 * short-circuit), which bricks ingest for any table with such a column (e.g. the
 * canonical `cursor: { column: "updated_at" }` incremental config). This is the
 * single boundary where driver-native types cross into DO SQLite JSON; a new
 * source driver (or a new non-JSON column type) must be normalized here too.
 * `shared/stable-key.ts`'s throw contract is intentionally left unchanged — this
 * normalizes the value *before* it can ever reach that encoder.
 */
const normalizeSourceValue = (value: unknown): unknown => {
    if (value instanceof Date) {
        return value.toISOString();
    }

    if (typeof value === "bigint") {
        return String(value);
    }

    if (Array.isArray(value)) {
        return value.map((element) => normalizeSourceValue(element));
    }

    if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion: a nested plain object is itself normalized field-by-field
        return normalizeSourceDocument(value as Record<string, unknown>);
    }

    return value;
};

/**
 * Normalize every field of a lifted document (see {@link normalizeSourceValue}).
 * Applied once at the lift boundary (inside {@link liftSourceId}) so both the
 * full-pull diff (`diffExternalSource`) and the incremental content short-circuit
 * (`materializeExternalRowsIncremental`) — and whatever a stored row reads back
 * as — see the same JSON-safe values.
 */
const normalizeSourceDocument = (document: Record<string, unknown>): Record<string, unknown> => {
    const normalized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(document)) {
        normalized[key] = normalizeSourceValue(value);
    }

    return normalized;
};

/**
 * Lift an external row to a Lunora document: the `idColumn` value becomes a
 * stringified `_id`, then either `map` shapes the body or every other column is
 * copied verbatim. Throws on a missing/null id, and on a non-scalar id, so a
 * misconfigured query fails loudly instead of materializing rows under the literal
 * id `"undefined"` (or collapsing many rows onto one id). Shared with
 * `@lunora/hyperdrive`'s `projectSourceRow`. The returned document's values are
 * normalized (see {@link normalizeSourceValue}) so a `Date`/`bigint` column never
 * reaches `stableStringify` un-normalized.
 */
const liftSourceId = (
    row: Record<string, unknown>,
    options: { idColumn?: string; map?: (row: Record<string, unknown>) => Record<string, unknown> } = {},
): Record<string, unknown> => {
    const { idColumn = "id", map } = options;
    const idValue = row[idColumn];

    if (idValue === undefined || idValue === null) {
        throw new LunoraError("INTERNAL", `external-source: row is missing id column "${idColumn}"`);
    }

    if (typeof idValue !== "string" && typeof idValue !== "number" && typeof idValue !== "bigint") {
        throw new TypeError(`external-source: id column "${idColumn}" must be a string or number`);
    }

    const id = String(idValue);

    if (map) {
        return normalizeSourceDocument({ ...map(row), _id: id });
    }

    const body: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(row)) {
        if (key !== idColumn) {
            body[key] = value;
        }
    }

    return normalizeSourceDocument({ ...body, _id: id });
};

export { liftSourceId, normalizeSourceDocument, normalizeSourceValue };
