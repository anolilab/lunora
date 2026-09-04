/**
 * The portable `NonRetryableError` and its boundary-conversion helpers.
 *
 * Cloudflare's own `NonRetryableError` lives in the runtime-only
 * `cloudflare:workflows` virtual module, so authoring code (`lunora/workflows.ts`)
 * and Node unit tests cannot import it. This Node-safe class lets a step throw a
 * fatal, no-retry failure portably; the `src/do` runtime converts it to the
 * native error at the workflow boundary so the Workers SDK fails the instance
 * immediately instead of retrying.
 *
 * The Workers SDK classifies non-retryable failures by error **name**, not
 * constructor identity, so this class fixes `name` to `"NonRetryableError"` —
 * which means it is already honored even before conversion. Conversion is the
 * belt-and-braces step that guarantees the native behavior.
 */

/** Brand marking a value as a Lunora portable {@link NonRetryableError}. */
const NON_RETRYABLE_BRAND = "__lunoraNonRetryable" as const;

/**
 * Throw from a workflow step (or handler) to fail the instance immediately
 * **without** retrying — the portable mirror of `cloudflare:workflows`'
 * `NonRetryableError`. Importable from Node, so workflow code stays unit-testable.
 *
 * ```ts
 * import { NonRetryableError } from "@lunora/workflow";
 *
 * if (order.status === "cancelled") {
 *     throw new NonRetryableError("order already cancelled — no point retrying");
 * }
 * ```
 */
class NonRetryableError extends Error {
    public constructor(message: string, name = "NonRetryableError") {
        super(message);
        // Subclassing `Error` does not set `name` from the constructor; the
        // Workers SDK keys off it, so set it explicitly (overridable for parity
        // with Cloudflare's `new NonRetryableError(message, name?)`).
        this.name = name;
        // Runtime brand — see `isNonRetryableError`. Set here rather than as a
        // computed class field so `--isolatedDeclarations` can emit the .d.ts (a
        // computed property name keyed by a const identifier is not inferable).
        (this as Record<string, unknown>)[NON_RETRYABLE_BRAND] = true;
    }
}

/** True when `value` is a Lunora portable {@link NonRetryableError}. */
const isNonRetryableError = (value: unknown): value is NonRetryableError =>
    value instanceof Error && (value as { [NON_RETRYABLE_BRAND]?: unknown })[NON_RETRYABLE_BRAND] === true;

/** Constructor shape of `cloudflare:workflows`' native `NonRetryableError`. */
type NativeNonRetryableErrorConstructor = new (message: string, name?: string) => Error;

/**
 * Rebuild a portable {@link NonRetryableError} as the native Cloudflare one,
 * preserving its `name`, `message`, `cause`, and `stack`. Used at the `src/do`
 * boundary where the native constructor is available; everywhere else the
 * portable error is thrown unchanged (and still honored by name).
 */
const toNativeNonRetryableError = (error: NonRetryableError, NativeNonRetryableError: NativeNonRetryableErrorConstructor): Error => {
    const native = new NativeNonRetryableError(error.message, error.name);

    if (error.stack !== undefined) {
        native.stack = error.stack;
    }

    if (error.cause !== undefined && native.cause === undefined) {
        (native as { cause?: unknown }).cause = error.cause;
    }

    return native;
};

/**
 * If `error` is a portable {@link NonRetryableError} and a native constructor is
 * available, rethrow it as the native error; otherwise rethrow `error` as-is.
 * Always throws — the `never` return lets callers `return convertNonRetryableError(...)`.
 */
const convertNonRetryableError = (error: unknown, NativeNonRetryableError: NativeNonRetryableErrorConstructor | undefined): never => {
    if (NativeNonRetryableError !== undefined && isNonRetryableError(error)) {
        throw toNativeNonRetryableError(error, NativeNonRetryableError);
    }

    throw error;
};

/**
 * Build a portable {@link NonRetryableError} for `message`, attach `cause` when
 * one is supplied, and immediately convert+throw it at the native boundary via
 * {@link convertNonRetryableError} — the construct → attach-cause → convert
 * sequence every non-retryable classification in `@lunora/workflow`'s
 * `createRunStep` performs (a deterministic dispatch failure, a failed
 * `returns` validation). Always throws — `return raiseNonRetryable(...)` reads
 * the same as `return convertNonRetryableError(...)`.
 */
const raiseNonRetryable = (message: string, cause: unknown, NativeNonRetryableError: NativeNonRetryableErrorConstructor | undefined): never => {
    const nonRetryable = new NonRetryableError(message);

    if (cause !== undefined) {
        nonRetryable.cause = cause;
    }

    return convertNonRetryableError(nonRetryable, NativeNonRetryableError);
};

export type { NativeNonRetryableErrorConstructor };
export { convertNonRetryableError, isNonRetryableError, NonRetryableError, raiseNonRetryable, toNativeNonRetryableError };
// `isDuplicateInstanceError` lives in `shared/` rather than here: `@lunora/runtime`'s
// scheduler dispatcher makes the same idempotency decision about the same rejection,
// but reaches the Workflows binding structurally and keeps no runtime dependency on
// this package. This package still OWNS the predicate as public API — the fan-out
// spawn and `@lunora/agent`'s sub-agent/channel dispatch import it from here.
export { isDuplicateInstanceError } from "../../../shared/duplicate-instance";
