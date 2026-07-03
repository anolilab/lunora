/**
 * Assertion helpers that throw a unified {@link LunoraError} instead of a bare
 * `Error`, so even "should never happen" invariants participate in the error
 * layer: they carry the `INTERNAL` code (redacted to a generic message on the
 * wire — an invariant breach is a bug, not a client-actionable error) while
 * staying rich in server logs and the CLI.
 */
import { LunoraError } from "./base";

/** Throw an `INTERNAL` {@link LunoraError} when `condition` is falsy. */
export const invariant: (condition: unknown, message: string) => asserts condition = (condition, message) => {
    if (!condition) {
        throw new LunoraError("INTERNAL", message, { name: "InvariantError" });
    }
};

/** Throw an `INTERNAL` {@link LunoraError} for an unreachable branch. */
export const unreachable = (message: string): never => {
    throw new LunoraError("INTERNAL", message, { name: "InvariantError" });
};
