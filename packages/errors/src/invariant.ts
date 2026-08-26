/**
 * Helpers that throw a unified {@link LunoraError} instead of a bare `Error`, so
 * even "should never happen" invariants participate in the error layer: they
 * carry the `INTERNAL` code (redacted to a generic message on the wire — an
 * invariant breach is a bug, not a client-actionable error) while staying rich in
 * server logs and the CLI.
 *
 * All three are declared as `const name: (…) => never = …` rather than
 * `const name = (…): never => …`. TypeScript only lets a call end a control-flow
 * path when the callee is a name whose *declaration* carries the annotation; an
 * inferred `const` does not qualify, the same restriction assertion functions
 * have. With the annotation on the arrow instead, `if (!row) { raise(…); }` would
 * leave `row` possibly-`null` on the next line.
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
 * @param code machine-readable reason, keyed into `ERROR_CATALOG`
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
