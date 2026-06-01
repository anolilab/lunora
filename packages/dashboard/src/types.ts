/** Which client method a {@link FunctionDescriptor} is invoked through. */
export type FunctionKind = "action" | "mutation" | "query";

/**
 * Runtime descriptor for a registered Cirrus function. The function's `kind` is
 * a compile-time-only phantom on `FunctionReference`, so the runner needs it
 * spelled out here to know which client method to call.
 */
export interface FunctionDescriptor {
    kind: FunctionKind;
    /** The `&lt;file>:&lt;function>` identifier, e.g. `messages:list`. */
    path: string;
}

/** Outcome of a single `FunctionRunner` invocation. */
export type RunStatus = "error" | "idle" | "running" | "success";
