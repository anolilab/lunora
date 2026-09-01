/**
 * The generated function-reference type, shared by every package that needs to
 * infer a call's args or return from `api.<file>.<fn>`.
 *
 * This lives in `shared/` rather than in one package because the consumers span
 * a dependency boundary they must not cross: `@lunora/scheduler` and
 * `@lunora/workflow` accept a reference in `runAfter`/`runAt`/`step.run*` but
 * cannot depend on `@lunora/client`, which is a browser package. Each of them
 * previously hand-copied this declaration, and both copies silently rotted when
 * the phantom carrier was renamed — the conditional matched an OPTIONAL property
 * that no longer existed, so `ArgsOf<F>` quietly resolved to `unknown` and every
 * `step.run(ref, args)` in the repo lost its arg checking without a single error.
 *
 * `shared/` is the repo's answer to exactly that shape: bundler-inlined,
 * zero-dependency source imported by relative path, so it creates no runtime
 * edge between the packages that inline it. Being ONE declaration, there is
 * nothing to keep in lockstep and no drift test to write.
 */

/** The registered function kinds a {@link FunctionReference} can describe. `stream` is a query that yields multiple frames over the WS. */
type FunctionKind = "action" | "mutation" | "query" | "stream";

/**
 * Opaque reference to a registered function emitted by `@lunora/codegen`.
 *
 * At runtime it carries the `<file>:<function>` identifier in `__lunoraRef`.
 * Generated declarations decorate this with phantom type parameters so callers
 * can infer args / return values per call site.
 */
interface FunctionReference<Kind extends FunctionKind = FunctionKind, Args = unknown, Return = unknown> {
    /**
     * Phantom marker carrying the `Kind`/`Args`/`Return` type parameters for
     * inference. Never present at runtime; declared as a covariant (output)
     * position so a concrete reference stays assignable to a widened one.
     */
    readonly __lunoraPhantom?: { args: Args; kind: Kind; returns: Return };
    readonly __lunoraRef: string;
}

/** Extract the args type from a {@link FunctionReference}. */
type ArgsOf<F> = F extends FunctionReference<infer _K, infer A, infer _R> ? A : never;

/** Extract the return type from a {@link FunctionReference}. */
type ReturnOf<F> = F extends FunctionReference<infer _K, infer _A, infer R> ? R : never;

export type { ArgsOf, FunctionKind, FunctionReference, ReturnOf };
