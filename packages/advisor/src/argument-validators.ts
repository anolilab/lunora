/**
 * One public procedure's argument validators reduced to the input-safety facts
 * the `public_arg_uses_any` and `unbounded_string_arg` lints consume: which args
 * are declared `v.any()` (unvalidated input) and which `v.string()` args carry no
 * length bound (a DoS / storage-abuse vector). Produced by the codegen feeder for
 * public procedures only; internal functions take server-trusted input. Runtime
 * callers don't supply it, so the lints find nothing there.
 */
export interface AdvisorArgumentValidator {
    /** Arg names declared as `v.any()`. */
    anyArgs: ReadonlyArray<string>;
    /** The exported binding name of the procedure (e.g. `updateProfile`). */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** 1-based line of the registration call, or `0` when unknown. */
    line: number;
    /** Arg names declared as `v.string()` with no statically-visible max-length bound. */
    unboundedStringArgs: ReadonlyArray<string>;
}
