import type { LunoraClient } from "@lunora/client";
import { LunoraError } from "@lunora/errors";
import type { Context } from "solid-js";
import { createContext, useContext } from "solid-js";

/**
 * Solid context carrying the framework-neutral {@link LunoraClient}. Every
 * reactive primitive in this adapter (`createQuery`, `createMutation`,
 * `hydratePreloaded`) reads the client from here, so a single
 * `<LunoraProvider client={…}>` at the root of the tree wires the whole app.
 *
 * Defaults to `undefined` so {@link useLunora} can throw a helpful error when a
 * primitive is used outside a provider rather than dereferencing it. Solid 2
 * refuses to hand back an `undefined` default at all — see {@link useLunora}.
 */
export const LunoraContext: Context<LunoraClient | undefined> = createContext<LunoraClient | undefined>();

/**
 * Read the {@link LunoraClient} from the nearest `<LunoraProvider>`.
 *
 * Throws when called outside a provider — the client is required to open the
 * HTTP/WS transport, so there is no sensible fallback. The React adapter's
 * `useLunora` has the same contract.
 */
export const useLunora = (): LunoraClient => {
    let client: LunoraClient | undefined;

    try {
        client = useContext(LunoraContext);
    } catch {
        /*
         * Solid 1.x returns the `undefined` default when no provider is above
         * the call; Solid 2 throws instead — `ContextNotFoundError` for a
         * default it considers absent, `NoOwnerError` when there is no reactive
         * owner at all. Both mean "no provider", which is what the guard below
         * reports by name. Without this, a 2.x user who forgets the provider
         * gets a bare framework error and none of the guidance.
         */
        client = undefined;
    }

    if (!client) {
        throw new LunoraError("INTERNAL", "useLunora must be used inside <LunoraProvider />");
    }

    return client;
};
