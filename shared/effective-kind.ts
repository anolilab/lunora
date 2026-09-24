/**
 * The *effective* kind of a column validator — the kind that describes the JS
 * value the column actually holds, with the wrappers that hide it removed:
 * `v.optional(inner)` unwrapped to whatever `inner` really is, and
 * `v.literal(x)` resolved to the kind of `x`.
 *
 * Every storage codec in the repo keys off the runtime value's JS type, so a
 * `v.optional(v.bigint())` column stores its present value exactly as
 * `v.bigint()` would. The validator's own `kind` is `"optional"`, which hides
 * that. Any guard, detector or decoder that reads `validator.kind` directly is
 * therefore correct for `v.bigint()` and silently wrong for
 * `v.optional(v.bigint())` — and "silently wrong" here has meant a `SUM` that
 * returns 2e+39 and a backfill completeness check that reports a clean table
 * when it is not.
 *
 * `"literal"` hides the same thing for the same reason. It names the CONSTRAINT
 * (one permitted value), never the type, so it answers nothing a codec or a
 * column type can be chosen from — see {@link literalKind}.
 *
 * It lives in `shared/` rather than in either package because both the DO row
 * store (`@lunora/shard-engine`) and the `.global()` store (`@lunora/sql-store`)
 * need it and neither depends on the other. Inlined by the bundler, so it adds
 * no dependency edge between them — and, more to the point, there is exactly one
 * definition of the rule instead of one per store.
 *
 * The inner validator is stashed on `_meta.inner` by `@lunora/values`'
 * `createValidator`; a literal's permitted value on `_meta.value`.
 * @returns the unwrapped kind, or `undefined` when the validator declares none
 */

/**
 * Structural shape of the validators this reads — kept local so `shared/` stays
 * dependency-free. `_meta` is `unknown` rather than `{ inner?: … }` so every
 * package's own `ValidatorLike` (each of which declares a different `_meta`
 * payload) is assignable without a cast at the call site.
 */
interface KindedValidator {
    readonly _meta?: unknown;
    readonly kind?: string | undefined;
}

/**
 * The storage kind of a `v.literal(x)` column: the kind of `x`.
 *
 * A literal permits exactly ONE value, so its type is that value's type and
 * nothing else. `"literal"` describes the constraint instead, and every consumer
 * of this module wants the type — so a literal fell to each one's `default`
 * branch and was handled as an opaque JSON/TEXT column. On the `.global()` plane
 * that meant a `v.literal(1)` column provisioned TEXT with no encode/decode
 * pairing: SQLite's TEXT affinity rewrote the bound number as the text `"1.0"`,
 * the read had no kind to reverse it with, and the row then failed its own
 * validator on the next `patch` (`expected literal 1, received "1.0"`).
 * `v.literal(true)` landed as `"1.0"` the same way, and `v.literal(7n)` read back
 * as 40 characters of `bigintSqlKey` padding.
 *
 * `null` maps to `"null"` — the kind `v.null()` carries — so the one value a
 * `v.literal(null)` column can hold is described by the same kind wherever it
 * appears. A literal that declares no `_meta.value` (a hand-built validator, or
 * one from a future shape) keeps answering `"literal"`: an unknown payload must
 * not silently acquire a column type.
 */
const literalKind = (validator: KindedValidator): string | undefined => {
    const { value } = (validator._meta as { value?: unknown } | undefined) ?? {};

    if (value === null) {
        return "null";
    }

    switch (typeof value) {
        case "bigint":
        case "boolean":
        case "number":
        case "string": {
            return typeof value;
        }
        default: {
            return validator.kind;
        }
    }
};

const effectiveKind = (validator: KindedValidator): string | undefined => {
    if (validator.kind === "literal") {
        return literalKind(validator);
    }

    if (validator.kind !== "optional") {
        return validator.kind;
    }

    const inner = (validator._meta as { inner?: KindedValidator } | undefined)?.inner;

    return inner ? effectiveKind(inner) : validator.kind;
};

export type { KindedValidator };
export { effectiveKind };
