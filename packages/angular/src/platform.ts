import type { DestroyRef, Injector } from "@angular/core";
import { effect, inject, NgZone, PLATFORM_ID, untracked } from "@angular/core";

/**
 * Whether a reactive primitive should open its live WebSocket subscription (and
 * start any network side effects) right now.
 *
 * `fromInjectionContext` must be `true` only when the caller is resolving its
 * dependencies from DI (a component/service field initializer or constructor) —
 * in practice, when no explicit `destroyRef` was passed, which is exactly when
 * the primitive already calls `inject(DestroyRef)`. On that path we read
 * `PLATFORM_ID` and return `false` on the Angular **server** platform (SSR):
 * Angular runs field initializers during a server render, and this repo's
 * supported Node range (^22.15) ships a global `WebSocket`, so an un-gated
 * `client.subscribe(...)` would fire a real connection on every SSR render —
 * throwing synchronously on the default relative `/_lunora/ws` URL, and, even
 * with an absolute `url`, silently opening a socket from the server.
 *
 * Everywhere else it returns `true`: the browser (`PLATFORM_ID === "browser"`),
 * and any manual-lifetime caller that passes its own `destroyRef`/`client` (so
 * `inject` must not run) and drives the socket itself. `PLATFORM_ID` is read
 * optionally so a bare `Injector.create` (no platform providers) resolves to
 * "attach" rather than throwing, and compared against the literal `"server"`
 * (Angular's `PLATFORM_SERVER_ID`) to keep this free of an `@angular/common`
 * dependency.
 */
export const shouldOpenSubscription = (fromInjectionContext: boolean): boolean => {
    if (!fromInjectionContext) {
        return true;
    }

    return inject(PLATFORM_ID, { optional: true }) !== "server";
};

/**
 * The deferred form of {@link runOutsideAngular}: resolve the zone escape NOW
 * (in the injection context) and apply it LATER. `inject(NgZone)` only works
 * while the primitive body is running, so a primitive that registers its
 * listeners asynchronously — `voiceAgent` opens its socket and its capture graph
 * inside `startCall`, after an `await` — cannot call `runOutsideAngular` at the
 * point it needs it.
 *
 * Worth the escape specifically there: a voice call's socket delivers a binary
 * audio frame per synthesized chunk and the capture graph reports an input level
 * roughly twelve times a second, so leaving them inside the zone is an app-wide
 * change-detection pass at audio rate for the whole call.
 */
export const outsideAngularRunner = (fromInjectionContext: boolean): (<T>(task: () => T) => T) => {
    const zone = fromInjectionContext ? inject(NgZone, { optional: true }) : undefined;

    if (!zone) {
        return <T>(task: () => T): T => task();
    }

    return <T>(task: () => T): T => zone.runOutsideAngular(task);
};

/**
 * Run `register` outside Angular's zone when a `NgZone` is available, so timers /
 * DOM listeners it sets up (and the callbacks they later fire) do not schedule an
 * app-wide change-detection pass. Signal writes still notify their consumers
 * regardless of the zone, so a view bound to a signal updated from such a
 * callback still refreshes correctly.
 *
 * `fromInjectionContext` gates the `inject(NgZone)` lookup for the same reason as
 * {@link shouldOpenSubscription}: only read from DI when the caller is resolving
 * from DI. Falls back to a direct call otherwise (a call made with an explicit
 * `destroyRef` outside DI, or a zoneless app with no `NgZone`).
 */
export const runOutsideAngular = <T>(fromInjectionContext: boolean, register: () => T): T => outsideAngularRunner(fromInjectionContext)(register);

/**
 * Wire the reactive-args form of a primitive: re-run `open` whenever the tracked
 * `args` thunk produces a new value, tearing the previous generation down first
 * (via the `onCleanup` handed to `open`), and stop the whole effect when the
 * owner is destroyed.
 *
 * `args` is read TRACKED — it is the only dependency the effect exists for.
 * `open` runs UNTRACKED, which is load-bearing rather than an optimisation: a
 * primitive that reads its own signals while building a generation (the
 * paginated engine reads its page list) would otherwise take a dependency on
 * them, so its very next write would re-run the effect, dispose the generation
 * it just built, and reset the primitive to its initial state.
 *
 * `manualCleanup: true` keeps teardown unified through the owner's `DestroyRef`
 * rather than also relying on whichever ambient `DestroyRef` the injector
 * happens to resolve.
 *
 * `effect()` needs an `Injector`, from `owner.injector` or from an ambient
 * injection context. The manual-lifetime combination — an explicit `destroyRef`,
 * no `injector`, called outside DI — is the one that has neither, and Angular's
 * own NG0203 for it never mentions the `injector` option that fixes it, so the
 * throw is re-raised with that named (the original kept as `cause`). Detected by
 * catching rather than by `isInInjectionContext`, which Angular 22 dropped and
 * this package's peer range still spans 19–22.
 */
export const attachReactiveArgs = <A>(
    args: () => A,
    owner: { destroyRef: DestroyRef; injector?: Injector },
    open: (resolved: A, onCleanup: (teardown: () => void) => void) => void,
): void => {
    let effectRef;

    try {
        effectRef = effect(
            (onCleanup) => {
                const resolved = args();

                untracked(() => {
                    open(resolved, onCleanup);
                });
            },
            { injector: owner.injector, manualCleanup: true },
        );
    } catch (error: unknown) {
        if (owner.injector !== undefined) {
            throw error;
        }

        throw new Error(
            "reactive `args` need an injection context: call this primitive from a component/service field or constructor, or pass `injector` alongside `destroyRef`.",
            { cause: error },
        );
    }

    owner.destroyRef.onDestroy(() => {
        effectRef.destroy();
    });
};
