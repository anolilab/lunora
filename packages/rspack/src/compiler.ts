/**
 * The slice of the Rspack compiler this plugin touches, projected structurally.
 *
 * `@rspack/core` is an OPTIONAL peer here, so its `Compiler` type must not appear
 * in the emitted `.d.ts` — a consumer without it installed would fail to resolve
 * the reference. Projecting the three hooks and one flag we tap also makes the
 * plugin work unchanged under webpack 5, whose plugin API these are taken from.
 *
 * A projection is only safe while it stays a real subset of the thing it
 * projects, and a renamed hook or a reshaped dependency set upstream would
 * silently stop it being one — this package would keep compiling and fail at the
 * first `rspack build`. `__tests__/compiler-projection.test.ts` asserts a real
 * `Compiler`/`Compilation` still satisfies every member below, so that drift is
 * a type error here rather than a runtime one in a user's project.
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

    /** Build errors; pushing here fails the build without aborting a watch session. */
    errors: Error[];

    /** Build warnings. */
    warnings: Error[];
}

/** The slice of `Compiler` this plugin taps. */
interface CompilerLike {
    hooks: {
        /** After each compilation seals — where watch dependencies are registered. */
        afterCompile: AsyncTapHook<CompilationLike>;

        /** Before each compilation — where codegen runs, so the build sees fresh output. */
        beforeCompile: AsyncTapHook<unknown>;
    };

    /** `true` under `rspack --watch` / `compiler.watch()`, `false` for a one-shot build. */
    watchMode?: boolean;
}

export type { AsyncTapHook, CompilationLike, CompilerLike, DependencySet };
