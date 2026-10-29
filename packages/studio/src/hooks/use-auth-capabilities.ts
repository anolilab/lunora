import type { AuthCapabilities } from "@lunora/client";

import { useAuthConfig } from "./use-auth-config";

/**
 * The worker's auth capabilities (which better-auth plugins are enabled) — a
 * thin selector over {@link useAuthConfig}, since `AuthConfigInfo.capabilities`
 * already carries everything this returns. Sharing the underlying
 * `["lunora-auth-config"]` read means a panel that gates on a plugin flag and a
 * panel that renders the full config detail dedupe onto one request rather than
 * fetching `getAuthCapabilities` and `getAuthConfig` separately. Returns the
 * conservative default capabilities until the fetch settles, with
 * `ready` flipping true once it has.
 */
const useAuthCapabilities = (): { capabilities: AuthCapabilities; ready: boolean } => {
    const { config, ready } = useAuthConfig();

    return { capabilities: config.capabilities, ready };
};

export default useAuthCapabilities;
