/**
 * Helpers that throw a unified {@link LunoraError} instead of a bare `Error`, so
 * even "should never happen" invariants participate in the error layer: they
 * carry the `INTERNAL` code (redacted to a generic message on the wire — an
 * invariant breach is a bug, not a client-actionable error) while staying rich in
 * server logs and the CLI.
 *
 * Each is annotated on the **declaration** rather than on the arrow —
 * `const name: (…) => never = …`, and `invariant` the assertion-function
 * equivalent `(…) => asserts condition`. TypeScript only lets a call narrow or
 * end a control-flow path when the callee is a name whose declaration carries
 * that annotation; an inferred `const` does not qualify. Written the other way
 * round (`const raise = (…): never => …`), `if (!row) { raise(…); }` would leave
 * `row` possibly-`null` on the next line, with nothing to warn you.
 */
import type { LunoraErrorCodeInput, LunoraErrorOptions } from "./base";
import { LunoraError } from "./base";

/** Throw an `INTERNAL` {@link LunoraError} when `condition` is falsy. */
export const invariant: (condition: unknown, message: string) => asserts condition = (condition, message) => {
    if (!condition) {
        throw new LunoraError("INTERNAL", message, { name: "InvariantError" });
    }
};

/** Throw an `INTERNAL` {@link LunoraError} for an unreachable branch. */
export const unreachable: (message: string) => never = (message) => {
    throw new LunoraError("INTERNAL", message, { name: "InvariantError" });
};

/**
 * Throw a {@link LunoraError} from expression position.
 *
 * `throw` is a statement, so it cannot sit on the right of `??` or in a ternary
 * arm — the two places a missing value is most naturally rejected. Unlike
 * {@link invariant} and {@link unreachable}, which are pinned to `INTERNAL`, this
 * takes the code, which is what a client-actionable failure needs.
 *
 * Any string is a valid `code`. A well-known `ERROR_CATALOG` key fills in the
 * status, title and hint; a package-specific code with no catalog entry defaults
 * to status 500 and no hint, so pass those in `options` instead.
 * @param code machine-readable reason
 * @param message human-readable detail; defaults to `code`
 * @param options status/title/hint/data overrides
 * @example
 * ```ts
 * const thread = (await ctx.db.threads.get(id)) ?? raise("NOT_FOUND", `thread ${id}`);
 * // thread is non-nullable here
 * ```
 */
export const raise: (code: LunoraErrorCodeInput, message?: string, options?: LunoraErrorOptions) => never = (code, message, options) => {
    throw new LunoraError(code, message, options);
};
