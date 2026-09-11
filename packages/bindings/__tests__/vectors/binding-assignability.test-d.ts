/**
 * The real Cloudflare `Vectorize` binding must satisfy {@link VectorizeIndexLike}
 * with no cast — the whole point of a structural projection. It did not: the
 * members were arrow properties taking `ReadonlyArray`, which
 * `strictFunctionTypes` checks contravariantly, while Cloudflare declares them as
 * methods over mutable arrays. `describe()` was worse than a type error — it
 * compiled, and read a `vectorsCount` the current binding does not have.
 *
 * Pinned from `@lunora/bindings` rather than from `@lunora/platform`, where the
 * type lives, because `platform` is zero-dependency and its tsconfig `types` list
 * is `["node"]` — it cannot see `@cloudflare/workers-types` at all.
 *
 * Type-only, and compiled by `lint:types` rather than run (vitest's `*.test.ts`
 * glob skips it): the assignment IS the assertion.
 */
import type { VectorizeIndexLike } from "@lunora/platform";

declare const binding: Vectorize;

export const vectorizeBindingConforms: VectorizeIndexLike = binding;

/** `describe()` is optional on the projection; the real binding always has it. */
export const describeConforms =
    (real: Vectorize): NonNullable<VectorizeIndexLike["describe"]> =>
    () =>
        real.describe();
