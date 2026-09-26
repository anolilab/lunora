/**
 * A process-wide "the auth session may have changed" signal between the code
 * that changes a session and the Lunora clients that must re-resolve it.
 *
 * Under a cookie session nothing a `LunoraClient` can observe changes when the
 * user signs in or out: the cookie is `HttpOnly` and set by a request the
 * client did not make. Whoever DID make it — the better-auth fetch plugin in
 * `@lunora/auth/plugins/client`, `@lunora/auth-ui`'s flows — calls
 * {@link notifySessionChanged}; every live `LunoraClient` in the page has
 * registered through {@link onSessionChanged} and asks `/get-session` who is
 * signed in now. The two sides share no import, so neither package depends on
 * the other.
 *
 * Keyed on a `Symbol.for` global, so copies of this file inlined into separate
 * bundles (it is bundler-inlined, not a package) still share one registry.
 *
 * Deliberately **not** a package: keep it zero-dependency. Consumers drop
 * `outDir`/`rootDir` from their `tsconfig.json` (see `shared/` in AGENTS.md).
 */

const REGISTRY_KEY = Symbol.for("lunora:session-change-listeners");

type Registry = Set<() => void>;

const registry = (): Registry => {
    const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
    let listeners = holder[REGISTRY_KEY];

    if (listeners === undefined) {
        listeners = new Set();
        holder[REGISTRY_KEY] = listeners;
    }

    return listeners;
};

/** Register a listener for {@link notifySessionChanged}. Returns the unregister function. */
const onSessionChanged = (listener: () => void): (() => void) => {
    const listeners = registry();

    listeners.add(listener);

    return () => {
        listeners.delete(listener);
    };
};

/** Tell every registered listener the session may have changed. A throwing listener never stops the others. */
const notifySessionChanged = (): void => {
    for (const listener of registry()) {
        try {
            listener();
        } catch {
            /* one listener's failure is not the others' concern */
        }
    }
};

export { notifySessionChanged, onSessionChanged };
