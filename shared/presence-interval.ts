/**
 * Reject a presence heartbeat interval that `setInterval` would not honour.
 *
 * Shared by the framework adapters' presence helpers (`@lunora/react`,
 * `@lunora/vue`, `@lunora/svelte`, `@lunora/solid`, `@lunora/angular`) so they
 * refuse the same values with the same message. `setInterval` clamps a
 * non-positive or non-finite delay to (nearly) zero, so such a value would
 * heartbeat in a tight loop.
 *
 * Like the sibling `shared/*` helpers this is deliberately **not** a package:
 * consumers import it by relative path and the bundler inlines it. Keep it
 * zero-dependency (relative/built-in imports only).
 */
const assertPresenceInterval = (intervalMs: number): void => {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        throw new RangeError(`presence intervalMs must be a positive number, got ${String(intervalMs)}`);
    }
};

export { assertPresenceInterval };
