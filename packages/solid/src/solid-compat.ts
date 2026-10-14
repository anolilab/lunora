import { LunoraError } from "@lunora/errors";
import type { Accessor, Context } from "solid-js";
// eslint-disable-next-line import/no-namespace -- load-bearing: the members below exist in only one major, and a named import of a missing export is an ESM link-time error. See the module comment.
import * as solid from "solid-js";

/**
 * The Solid 1.x ⇄ 2.x compatibility layer.
 *
 * `@lunora/solid` supports both Solid majors from a single build. Almost the
 * whole adapter is already version-neutral — `createSignal`, `createMemo`,
 * `createEffect`, `createContext`, `useContext`, `onCleanup`, `Show` and
 * `createComponent` all exist, unchanged, in both. Four things do not, and this
 * module is the only place that knows about them.
 *
 * Reacting to a source: 1.x spells it `createEffect(on(source, apply))`; 2.0
 * deleted `on` in favour of the split-phase `createEffect(compute, apply)`.
 * See {@link trackedEffect}.
 *
 * Mount-time setup: 1.x has `onMount`; 2.0 replaced it with `onSettled`, which
 * takes the teardown as a return value rather than a nested `onCleanup`.
 * See {@link onMounted}.
 *
 * Context providers: 1.x renders `Ctx.Provider`; in 2.0 the context object is
 * itself the provider component. See {@link providerOf}.
 *
 * The element type: 1.x exports the `JSX` namespace from `solid-js`; 2.0 moved
 * JSX typing into the renderer package (`@solidjs/web`) and exports a neutral
 * `Element`. See {@link SolidChildren} and {@link SolidElement}.
 *
 * Everything version-specific is reached through the `solid` **namespace**
 * object, never a named import: `import { on } from "solid-js"` is an ESM
 * link-time error under 2.x, where the export no longer exists, and would break
 * the package for every 2.x consumer regardless of whether the code path runs.
 */

/** Teardown returned by an effect or mount body, or nothing to clean up. */
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- `void` is the point: a body that cleans nothing up simply returns, and `undefined` would reject those callbacks.
type Disposer = (() => void) | void;

/**
 * Children accepted by this adapter's components.
 *
 * Structurally identical to Solid 2.0's `Element`, which is in turn a widening
 * of 1.x's `JSX.Element` (a DOM `Node` satisfies `object` with no
 * `call`/`apply`/`bind`). Children are contravariant, so one union that accepts
 * both majors' element types is enough — no `any` required here.
 */
type SolidChildren =
    | SolidChildrenArray
    | boolean
    | null
    | number
    | (object & { readonly apply?: never; readonly bind?: never; readonly call?: never })
    | (string & {})
    | undefined;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- an interface extending Array is the only way to declare a recursive array type; both Solid majors declare their own `ArrayElement` exactly like this.
interface SolidChildrenArray extends Array<SolidChildren> {}

/**
 * The return type of this adapter's components.
 *
 * Deliberately `any`, and the one place in the package where that is the right
 * answer. TypeScript checks a component's return type against the *renderer's*
 * `JSX.Element`, and the two majors define that incompatibly — 1.x's is rooted
 * in the DOM `Node` interface, 2.0's in an opaque `RenderedElement`. Neither is
 * assignable to the other, so no concrete type satisfies both, and a structural
 * union (as used for {@link SolidChildren}) fails in the return position. `any`
 * is what lets one set of `.d.ts` files type-check inside a 1.x app and a 2.x
 * app alike.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any, sonarjs/redundant-type-aliases -- see the doc comment: no concrete type is assignable to both majors' JSX.Element, and the alias is what documents that at every use site.
type SolidElement = any;

/**
 * The `solid-js` members that exist in only ONE of the two supported majors.
 * The installed package's own types describe exactly one of them, so the
 * namespace is re-viewed through this interface rather than cast per call site.
 */
interface VersionedSolid {
    /** 1.x only — folded into the two-argument `createEffect` in 2.0. */
    on?: <S>(source: Accessor<S>, function_: (value: S) => void) => () => void;
    /** 1.x only — superseded by `onSettled`. */
    onMount?: (function_: () => void) => void;
    /** 2.0 only — the mount-and-teardown primitive that replaced `onMount`. */
    onSettled?: (function_: () => Disposer) => void;
}

const runtime = solid as unknown as VersionedSolid;

/**
 * `true` when the installed `solid-js` is 2.x.
 *
 * `onSettled` is the marker: it is new in 2.0, it is exported from the package
 * root, and it is not a removal (so it cannot be confused with a 1.x export
 * that a bundler happened to tree-shake).
 */
const isSolid2: boolean = typeof runtime.onSettled === "function";

/**
 * Read a member the detected major is expected to export, failing loudly if the
 * installed `solid-js` matches neither major's shape.
 *
 * Without this, a mismatch surfaces as `undefined is not a function` from
 * somewhere deep in a subscription callback. The peer range should make this
 * unreachable; a duplicated or aliased Solid install is how it happens anyway.
 */
const requireSolidMember = <T>(member: T | undefined, name: string): T => {
    if (member === undefined) {
        throw new LunoraError(
            "INTERNAL",
            `@lunora/solid could not find \`${name}\` on the installed solid-js. Expected Solid 1.x (which exports it) or 2.x (which exports \`onSettled\`); found neither.`,
        );
    }

    return member;
};

/**
 * Run `apply` whenever `source` changes, tearing down the previous run first.
 *
 * `apply` **returns** its teardown rather than calling `onCleanup` — that is
 * 2.0's contract for the apply phase, and the 1.x branch adapts it by
 * registering the returned disposer itself. `apply` never tracks: in 2.0 the
 * apply phase is untracked by construction, and in 1.x `on(...)` gives the same
 * guarantee.
 *
 * ```ts
 * trackedEffect(resolveArgs, (args) => {
 *     const unsubscribe = client.subscribe(reference, args, onData);
 *
 *     return unsubscribe;
 * });
 * ```
 */
const trackedEffect = <T>(source: Accessor<T>, apply: (value: T) => Disposer): void => {
    if (isSolid2) {
        (solid.createEffect as unknown as (compute: Accessor<T>, effect: (value: T) => Disposer) => void)(source, apply);

        return;
    }

    const on = requireSolidMember(runtime.on, "on");

    solid.createEffect(
        on(source, (value) => {
            const dispose = apply(value);

            if (dispose) {
                solid.onCleanup(dispose);
            }
        }),
    );
};

/**
 * Run `setup` once the owning scope has mounted, and tear it down on dispose.
 *
 * The 1.x `onMount` + nested `onCleanup` pair and 2.0's `onSettled` differ only
 * in how the teardown is handed back, so callers always return it. Neither
 * major runs this during SSR, which is what keeps socket work off the server.
 */
const onMounted = (setup: () => Disposer): void => {
    if (isSolid2) {
        requireSolidMember(runtime.onSettled, "onSettled")(setup);

        return;
    }

    requireSolidMember(
        runtime.onMount,
        "onMount",
    )(() => {
        const dispose = setup();

        if (dispose) {
            solid.onCleanup(dispose);
        }
    });
};

/** A context's provider component, as this adapter calls it. */
type ContextProvider<T> = (props: { children: SolidChildren; value: T }) => SolidElement;

/**
 * The provider component for a context.
 *
 * 1.x hangs it off the context as `.Provider`; in 2.0 the context object is
 * itself the provider. Probing for the property covers both without consulting
 * {@link isSolid2}, so the two detections can never disagree.
 *
 * The probe casts to a standalone shape rather than intersecting with
 * `Context<T>`: 1.x's own type declares `Provider` as required, so an
 * intersection would convince TypeScript the 2.0 fallback is unreachable.
 */
const providerOf = <T>(context: Context<T>): ContextProvider<T> => {
    const { Provider } = context as unknown as { Provider?: ContextProvider<T> };

    return Provider ?? (context as unknown as ContextProvider<T>);
};

export type { Disposer, SolidChildren, SolidElement };
export { isSolid2, onMounted, providerOf, trackedEffect };
