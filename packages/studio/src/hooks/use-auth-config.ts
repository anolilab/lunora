import type { AuthConfigInfo } from "@lunora/client";
import { useLunora } from "@lunora/react";

import { useClientQuery } from "./use-admin-query";

/**
 * Conservative defaults until `getAuthConfig()` resolves: core capabilities on,
 * plugin surfaces off, no plugin-derived user fields, no social providers, and
 * an empty (disabled) session / rate-limit policy. This is the single source of
 * truth for the "before the fetch settles" shape; the `useAuthCapabilities`
 * selector reuses the `capabilities` slice of this constant as its own fallback.
 */
export const DEFAULT_AUTH_CONFIG: AuthConfigInfo = {
    capabilities: { accounts: true, admin: true, inviteOnly: false, organization: false, passkey: false, twoFactor: false },
    emailAndPassword: false,
    organization: { enabled: false, roles: false, teams: false },
    plugins: [],
    rateLimit: { enabled: false },
    session: {},
    socialProviders: [],
    userFields: [],
};

/**
 * Fetch the worker's full auth configuration (it's fixed per deployment — which
 * better-auth plugins are enabled, the email/password + social providers, the
 * session policy, the plugin-derived user fields). Reads through the shared
 * `useClientQuery` cache under a stable `["lunora-auth-config"]` key, so every
 * consumer — the config overview panel, the create-user field set, the org
 * panel, and `useAuthCapabilities` (a thin selector over this) — dedupes onto
 * one in-flight request and one cache entry.
 *
 * Returns the conservative {@link DEFAULT_AUTH_CONFIG} until the fetch settles
 * (or if it fails, e.g. a read-only `authAdmin` plane with no `config` op),
 * with `ready` flipping true once it has (`retry: 0` on the query client means
 * an error settles immediately rather than retrying). The richer sibling of
 * `useAuthCapabilities`: panels that only gate on a plugin flag use that; panels
 * that render the config detail use this.
 */
export const useAuthConfig = (): { config: AuthConfigInfo; ready: boolean } => {
    const client = useLunora();
    const { data, isLoading } = useClientQuery<AuthConfigInfo>(["lunora-auth-config"], () => client.getAuthConfig());

    return { config: data ?? DEFAULT_AUTH_CONFIG, ready: !isLoading };
};
