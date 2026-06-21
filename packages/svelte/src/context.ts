import type { LunoraClient } from "@lunora/client";
import { getContext, setContext } from "svelte";

/**
 * Context key for the per-app {@link LunoraClient}. A `Symbol` (not a string)
 * so it can never collide with another library's context entry.
 */
const LUNORA_CONTEXT_KEY = Symbol("lunora.client");

/**
 * Publish a {@link LunoraClient} on the Svelte component context so that
 * descendant components can read it with {@link getLunoraClient} (or implicitly,
 * via the default-client lookups inside `query`/`mutation`/`hydratePreloaded`).
 *
 * Call this once, high in the tree (typically your root `+layout.svelte` or
 * `App.svelte`), during component initialisation — `setContext` must run while
 * the component is being constructed, exactly like React's provider mounts once.
 * This is the Svelte analogue of mounting `LunoraProvider`.
 */
export const setLunoraClient = (client: LunoraClient): LunoraClient => {
    setContext(LUNORA_CONTEXT_KEY, client);

    return client;
};

/**
 * Read the {@link LunoraClient} published by {@link setLunoraClient} from the
 * nearest ancestor. Throws if no provider is mounted, mirroring `useLunora`'s
 * "must be used inside a LunoraProvider" guard so the failure is loud and
 * early rather than a confusing `undefined` deref later.
 *
 * Must be called during component initialisation (Svelte's `getContext`
 * constraint); the live stores returned by `query`/`hydratePreloaded` resolve
 * the client eagerly at call time for exactly this reason.
 */
export const getLunoraClient = (): LunoraClient => {
    const client = getContext<LunoraClient | undefined>(LUNORA_CONTEXT_KEY);

    if (!client) {
        throw new Error("getLunoraClient(): no LunoraClient in context — call setLunoraClient(client) in an ancestor component first.");
    }

    return client;
};
