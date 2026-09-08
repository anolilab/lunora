/**
 * The real Cloudflare `Vectorize` binding must satisfy {@link VectorizeIndexLike}
 * with no cast — the whole point of a structural projection.
 *
 * It did not: `deleteByIds`/`getByIds`/`insert`/`upsert`/`query` were declared as
 * arrow properties taking `ReadonlyArray`, which `strictFunctionTypes` checks
 * contravariantly, while Cloudflare declares them as methods over mutable arrays.
 * `describe()` was worse than a type error — it compiled, and read a `vectorsCount`
 * the current binding does not have.
 *
 * Type-only, and deliberately compiled by `lint:types` rather than run: there is
 * nothing to execute, and the assignment IS the assertion.
 */
import type { VectorizeIndexLike } from "@lunora/platform";

declare const binding: Vectorize;

const realBindingSatisfiesTheProjection: VectorizeIndexLike = binding;

export default realBindingSatisfiesTheProjection;
