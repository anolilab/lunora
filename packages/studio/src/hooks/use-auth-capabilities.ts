import type { AuthCapabilities } from "@cirrus/client";
import { useCirrus } from "@cirrus/react";
import { useEffect, useState } from "react";

import { fireAndForget } from "../lib/internal";

/** Conservative defaults until `getAuthCapabilities()` resolves: core surfaces on, plugin surfaces off. */
export const DEFAULT_CAPABILITIES: AuthCapabilities = { accounts: true, admin: true, organization: false, passkey: false, twoFactor: false };

/**
 * Fetch the worker's auth capabilities once (they're fixed per deployment — which
 * better-auth plugins are enabled). Returns the conservative {@link DEFAULT_CAPABILITIES}
 * until the fetch settles (or if it fails, e.g. a read-only `authIntrospector`
 * that has no `capabilities` op), with `ready` flipping true once it has. Shared
 * by every panel that gates a surface on a plugin.
 */
export const useAuthCapabilities = (): { capabilities: AuthCapabilities; ready: boolean } => {
    const client = useCirrus();
    const [capabilities, setCapabilities] = useState<AuthCapabilities>(DEFAULT_CAPABILITIES);
    const [ready, setReady] = useState<boolean>(false);

    useEffect(() => {
        fireAndForget(
            (async (): Promise<void> => {
                try {
                    setCapabilities(await client.getAuthCapabilities());
                } catch {
                    // Leave the conservative defaults in place if the endpoint is unavailable.
                } finally {
                    setReady(true);
                }
            })(),
        );
    }, [client]);

    return { capabilities, ready };
};
