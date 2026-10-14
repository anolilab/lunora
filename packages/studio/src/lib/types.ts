/** Which client method a {@link FunctionDescriptor} is invoked through. */
export type FunctionKind = "action" | "mutation" | "query";

/**
 * One argument of a registered function, derived from its `v.*` validator by the
 * worker's `/_lunora/admin/functions` endpoint. A compact signature shape.
 */
export interface FunctionArgumentDescriptor {
    /** Element validator kind for an `array` arg (one level), e.g. `string`. */
    element?: string;
    /** The (optional-unwrapped) validator kind, e.g. `string`, `id`, `object`. */
    kind: string;
    /** The argument name. */
    name: string;
    /** True when the arg is wrapped in `v.optional(...)`. */
    optional: boolean;
    /** Target table for an `id` arg (`v.id("table")`). */
    table?: string;
}

/**
 * Runtime descriptor for a registered Lunora function. The function's `kind` is
 * a compile-time-only phantom on `FunctionReference`, so the runner needs it
 * spelled out here to know which client method to call. `args` carries the
 * function's argument signature (absent on responses from an older worker).
 */
export interface FunctionDescriptor {
    args?: FunctionArgumentDescriptor[];
    kind: FunctionKind;
    /** The `<file>:<function>` identifier, e.g. `messages:list`. */
    path: string;
}

/** Outcome of a single `FunctionRunner` invocation. */
export type RunStatus = "error" | "idle" | "running" | "success";
