/**
 * The slice of the Rspack compiler this plugin touches, projected structurally.
 *
 * `@rspack/core` is an OPTIONAL peer here, so its `Compiler` type must not appear
 * in the emitted `.d.ts` — a consumer without it installed would fail to resolve
 * the reference. Projecting only what we tap also makes the plugin work unchanged
 * under webpack 5, whose plugin API these members come from.
 *
 * A projection is only safe while it stays a real subset of the thing it
 * projects, and a renamed hook or a reshaped dependency set upstream would
 * silently stop it being one — this package would keep compiling and fail at the
 * first `rspack build`. `__tests__/compiler-projection.test.ts` asserts a real
 * `Compiler`/`Compilation` still satisfies every member below, so that drift is a
 * type error here rather than a runtime one in a user's project.
 */

/** A `lite-tapable` async hook, narrowed to the `tapPromise` registration we use. */
interface AsyncTapHook<T> {
    tapPromise: (name: string, callback: (value: T) => Promise<void>) => void;
}

/** The mutable dependency set a compilation exposes for watch invalidation. */
interface DependencySet {
    add: (dependency: string) => void;
}

/** The slice of `Compilation` this plugin reads or mutates. */
interface CompilationLike {
    /** Directories whose contents invalidate this compilation when they change. */
    contextDependencies: DependencySet;

    /**
     * Build errors. Pushing here fails the build — `stats.hasErrors()` goes true,
     * assets are not emitted, and the CLI exits non-zero — WITHOUT aborting a
     * watch session, which is why every blocking finding this plugin reports goes
     * here rather than out of a rejected hook.
     */
    errors: Error[];

    /** Individual files that invalidate this compilation when they change. */
    fileDependencies: DependencySet;
}

/** The slice of `Compiler` this plugin taps. */
interface CompilerLike {
    hooks: {
        /** After each compilation seals — where dependencies and findings are registered. */
        afterCompile: AsyncTapHook<CompilationLike>;

        /** Before each compilation — where codegen runs, so the build sees fresh output. */
        beforeCompile: AsyncTapHook<unknown>;
    };

    /**
     * `true` under `compiler.watch()`, `false` for a one-shot `compiler.run()`.
     *
     * Only ever read from INSIDE a hook callback. `apply()` runs during
     * `createCompiler()`, before `watch()` assigns this — read at tap time it is
     * unconditionally `false`, which silently inverts every decision that depends
     * on it.
     */
    watchMode?: boolean;
}

export type { AsyncTapHook, CompilationLike, CompilerLike, DependencySet };
