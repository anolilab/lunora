/**
 * `lazyValue` — a single-slot "load this on first use" cache for the heavy SDK an
 * integration is handed as a loader (`@cloudflare/playwright`, `stripe`, a
 * Postgres driver, the MCP SDK).
 *
 * The loaders exist so the SDK stays out of the Worker's startup graph: a static
 * `import` in the app's entry is evaluated by every isolate before its first
 * event, and Cloudflare rejects a Worker whose global scope takes more than 1 s
 * of CPU (error 10021). A loader is `() => import("sdk")` (or builds a client
 * from it), awaited inside the integration's own async methods.
 *
 * The promise is stored, so a burst of first calls coalesces onto one load. A
 * rejection is NOT kept: it reaches the caller that triggered it, unchanged, and
 * the next call retries — a cached failure would turn one transient fault into
 * a broken integration for the isolate's whole life. The eviction is
 * identity-checked for the reason `promise-memo.ts` gives.
 *
 * Like the other `shared/` helpers this is deliberately **not** a package:
 * consumers import it by relative path and the bundler inlines it. Keep it
 * genuinely zero-dependency.
 */
const lazyValue = <T>(load: () => Promise<T> | T): (() => Promise<T>) => {
    let pending: Promise<T> | undefined;

    return () => {
        if (pending !== undefined) {
            return pending;
        }

        const started = (async () => await load())().catch((error: unknown) => {
            if (pending === started) {
                pending = undefined;
            }

            throw error;
        });

        pending = started;

        return started;
    };
};

export { lazyValue };
