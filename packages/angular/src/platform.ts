import { inject, NgZone, PLATFORM_ID } from "@angular/core";

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
export const runOutsideAngular = <T>(fromInjectionContext: boolean, register: () => T): T => {
    const zone = fromInjectionContext ? inject(NgZone, { optional: true }) : null;

    return zone ? zone.runOutsideAngular(register) : register();
};
