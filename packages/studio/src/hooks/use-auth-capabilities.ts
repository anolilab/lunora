import type { AuthCapabilities } from "@lunora/client";

import { DEFAULT_AUTH_CONFIG, useAuthConfig } from "./use-auth-config";

/** Conservative defaults until the config resolves: core surfaces on, plugin surfaces off. Derived from the canonical {@link DEFAULT_AUTH_CONFIG}. */
export const DEFAULT_CAPABILITIES: AuthCapabilities = DEFAULT_AUTH_CONFIG.capabilities;

/**
 * The worker's auth capabilities (which better-auth plugins are enabled) — a
 * thin selector over {@link useAuthConfig}, since `AuthConfigInfo.capabilities`
 * already carries everything this returns. Sharing the underlying
 * `["lunora-auth-config"]` read means a panel that gates on a plugin flag and a
 * panel that renders the full config detail dedupe onto one request rather than
 * fetching `getAuthCapabilities` and `getAuthConfig` separately. Returns the
 * conservative {@link DEFAULT_CAPABILITIES} until the fetch settles, with
 * `ready` flipping true once it has.
 */
export const useAuthCapabilities = (): { capabilities: AuthCapabilities; ready: boolean } => {
    const { config, ready } = useAuthConfig();

    return { capabilities: config.capabilities, ready };
};
