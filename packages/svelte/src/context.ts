import type { CirrusClient } from "@cirrus/client";
import { getContext, setContext } from "svelte";

/**
 * Context key for the per-app {@link CirrusClient}. A `Symbol` (not a string)
 * so it can never collide with another library's context entry.
 */
const CIRRUS_CONTEXT_KEY = Symbol("cirrus.client");

/**
 * Publish a {@link CirrusClient} on the Svelte component context so that
 * descendant components can read it with {@link getCirrusClient} (or implicitly,
 * via the default-client lookups inside `query`/`mutation`/`hydratePreloaded`).
 *
 * Call this once, high in the tree (typically your root `+layout.svelte` or
 * `App.svelte`), during component initialisation — `setContext` must run while
 * the component is being constructed, exactly like React's provider mounts once.
 * This is the Svelte analogue of mounting `CirrusProvider`.
 */
export const setCirrusClient = (client: CirrusClient): CirrusClient => {
    setContext(CIRRUS_CONTEXT_KEY, client);

    return client;
};

/**
 * Read the {@link CirrusClient} published by {@link setCirrusClient} from the
 * nearest ancestor. Throws if no provider is mounted, mirroring `useCirrus`'s
 * "must be used inside a CirrusProvider" guard so the failure is loud and
 * early rather than a confusing `undefined` deref later.
 *
 * Must be called during component initialisation (Svelte's `getContext`
 * constraint); the live stores returned by `query`/`hydratePreloaded` resolve
 * the client eagerly at call time for exactly this reason.
 */
export const getCirrusClient = (): CirrusClient => {
    const client = getContext<CirrusClient | undefined>(CIRRUS_CONTEXT_KEY);

    if (!client) {
        throw new Error("getCirrusClient(): no CirrusClient in context — call setCirrusClient(client) in an ancestor component first.");
    }

    return client;
};
