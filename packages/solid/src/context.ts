import type { CirrusClient } from "@cirrus/client";
import type { Context } from "solid-js";
import { createContext, useContext } from "solid-js";

/**
 * Solid context carrying the framework-neutral {@link CirrusClient}. Every
 * reactive primitive in this adapter (`createQuery`, `createMutation`,
 * `hydratePreloaded`) reads the client from here, so a single
 * `&lt;CirrusProvider client={…}>` at the root of the tree wires the whole app.
 *
 * Defaults to `undefined` so {@link useCirrus} can throw a helpful error when a
 * primitive is used outside a provider rather than dereferencing it.
 */
export const CirrusContext: Context<CirrusClient | undefined> = createContext<CirrusClient | undefined>();

/**
 * Read the {@link CirrusClient} from the nearest `&lt;CirrusProvider>`.
 *
 * Throws when called outside a provider — the client is required to open the
 * HTTP/WS transport, so there is no sensible fallback. The React adapter's
 * `useCirrus` has the same contract.
 */
export const useCirrus = (): CirrusClient => {
    const client = useContext(CirrusContext);

    if (!client) {
        throw new Error("useCirrus must be used inside <CirrusProvider />");
    }

    return client;
};
