/**
 * The *effective* kind of a column validator — `v.optional(inner)` unwrapped to
 * whatever `inner` really is.
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
 * It lives in `shared/` rather than in either package because both the DO row
 * store (`@lunora/shard-engine`) and the `.global()` store (`@lunora/sql-store`)
 * need it and neither depends on the other. Inlined by the bundler, so it adds
 * no dependency edge between them — and, more to the point, there is exactly one
 * definition of the rule instead of one per store.
 *
 * The inner validator is stashed on `_meta.inner` by `@lunora/values`'
 * `createValidator`.
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

const effectiveKind = (validator: KindedValidator): string | undefined => {
    if (validator.kind !== "optional") {
        return validator.kind;
    }

    const inner = (validator._meta as { inner?: KindedValidator } | undefined)?.inner;

    return inner ? effectiveKind(inner) : validator.kind;
};

export type { KindedValidator };
export { effectiveKind };
