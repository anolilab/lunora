/**
 * Does a column validator accept `null` without being `.nullable()`?
 *
 * `v.any()`, `v.null()`, `v.literal(null)`, and a `v.union(…)` with any of those
 * as a member all keep the default `notNull: true` column flag, yet parse `null`
 * happily. A DDL builder that emitted `NOT NULL` off that flag alone provisioned
 * a column the engine refuses the very value the validator just accepted: the
 * Durable Object stored the document, while D1, Postgres and MySQL raised a raw
 * NOT NULL constraint error for it.
 *
 * Two DDL builders need the answer — the runtime auto-provisioner
 * (`@lunora/sql-store`, reading live validators) and `lunora migrate generate`
 * (`@lunora/cli`, reading codegen's IR) — and they must agree, because the
 * migration file promises the same table the runtime provisions. So the rule
 * lives here once, with one adapter per validator shape.
 *
 * `v.from(schema)` is NOT counted: an external schema's null handling is not
 * visible to either shape, and the rule stays with what both can prove.
 */
import type { KindedValidator } from "./effective-kind";
import { effectiveKind } from "./effective-kind";

/** The kinds that parse `null` on their own. `literal(null)` resolves to `"null"` before it gets here. */
const NULL_ACCEPTING_KINDS = new Set(["any", "null"]);

/** The one rule: a null-accepting kind, or a union with a null-accepting member. */
const acceptsNullBy = <T>(node: T, kindOf: (node: T) => string | undefined, membersOf: (node: T) => ReadonlyArray<T> | undefined): boolean => {
    const kind = kindOf(node);

    if (kind !== undefined && NULL_ACCEPTING_KINDS.has(kind)) {
        return true;
    }

    return kind === "union" && (membersOf(node) ?? []).some((member) => acceptsNullBy(member, kindOf, membersOf));
};

/** For a live `@lunora/values` validator: `v.optional` unwrapped and `v.literal(null)` resolved by {@link effectiveKind}. */
const validatorAcceptsNull = (validator: KindedValidator): boolean =>
    acceptsNullBy(validator, effectiveKind, (node) => {
        const meta = node._meta as { inner?: KindedValidator; members?: ReadonlyArray<KindedValidator> } | undefined;

        return node.kind === "optional" && meta?.inner ? (meta.inner._meta as typeof meta)?.members : meta?.members;
    });

/** Structural slice of `@lunora/codegen`'s `ValidatorIR` — kept local so `shared/` stays dependency-free. */
interface NullableIr {
    readonly inner?: NullableIr;
    readonly kind: string;
    /** A literal's value as source text. */
    readonly literalValue?: string;
    readonly members?: ReadonlyArray<NullableIr>;
}

/** The IR's effective kind, with the same two unwraps {@link effectiveKind} applies to a live validator. */
const irKind = (ir: NullableIr): string => {
    if (ir.kind === "optional" && ir.inner) {
        return irKind(ir.inner);
    }

    return ir.kind === "literal" && ir.literalValue === "null" ? "null" : ir.kind;
};

/** For codegen's `ValidatorIR`, as `lunora migrate generate` reads the schema. */
const irAcceptsNull = (ir: NullableIr): boolean => acceptsNullBy(ir, irKind, (node) => (node.kind === "optional" && node.inner ? node.inner : node).members);

export type { NullableIr };
export { irAcceptsNull, validatorAcceptsNull };
