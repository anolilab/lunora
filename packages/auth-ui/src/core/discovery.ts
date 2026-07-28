/**
 * Ask the server what it supports, instead of being told twice.
 *
 * `flow-gate.ts` explains why a better-auth client cannot be probed: it is a
 * dynamic-path `Proxy`, so every plugin method appears to exist. Its answer was
 * to have `client.ts` *declare* the plugin set. This module removes even that
 * for anyone running `uiConfig()` server-side (`@lunora/auth/plugins`): a plain
 * `GET {basePath}/ui-config` returns the resolved plugin ids and social provider
 * ids, and the cards configure themselves.
 *
 * The two sources are combined rather than ranked, because they answer different
 * questions. The server knows whether an endpoint exists; the client
 * registration knows whether the matching *client* plugin was installed. A flow
 * needs both — `passkey` without `passkeyClient()` has a live endpoint and no
 * WebAuthn ceremony to call it — so known values are ANDed. See `resolvePlugins`
 * in `config.ts`.
 *
 * Failure is silent by design. A deployment without the plugin answers 404, an
 * offline browser throws; both resolve to `unavailable`, and the gate falls back
 * to what `client.ts` registered. Discovery is an upgrade, never a dependency.
 */
import { createStore } from "./store";

/** Organization sub-features, mirroring the server payload. */
interface DiscoveredOrganization {
    enabled: boolean;
    roles: boolean;
    teams: boolean;
}

/** The payload `GET {basePath}/ui-config` returns (see `@lunora/auth`'s `uiConfig`). */
interface DiscoveredConfig {
    emailAndPassword: boolean;
    organization: DiscoveredOrganization;
    plugins: ReadonlyArray<string>;
    signUp: boolean;
    socialProviders: ReadonlyArray<string>;
}

type DiscoveryStatus = "loading" | "ready" | "unavailable";

interface DiscoveryState {
    config?: DiscoveredConfig;
    status: DiscoveryStatus;
}

interface DiscoveryHandle {
    getState: () => DiscoveryState;
    subscribe: (onChange: () => void) => () => void;
}

/**
 * better-auth plugin id → the flow name the cards gate on. Ids are the plugin's
 * own `id` field, which is stable API (better-auth keys its client namespaces
 * off the same string).
 */
const PLUGIN_ID_TO_FLOW: Readonly<Record<string, string>> = {
    admin: "admin",
    anonymous: "anonymous",
    "device-authorization": "deviceAuthorization",
    "email-otp": "emailOtp",
    "last-login-method": "lastLoginMethod",
    "magic-link": "magicLink",
    "multi-session": "multiSession",
    organization: "organization",
    passkey: "passkey",
    "phone-number": "phoneNumber",
    "two-factor": "twoFactor",
    username: "username",
};

/**
 * One in-flight request per endpoint, shared by every provider on the page.
 *
 * Module-level rather than per-provider so mounting `<SignInCard>` and
 * `<UserButton>` under two providers doesn't fetch twice. Keyed by the resolved
 * URL, so an app talking to two deployments still gets two answers.
 */
const handles = new Map<string, DiscoveryHandle>();

const isConfig = (value: unknown): value is DiscoveredConfig => {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const candidate = value as Partial<DiscoveredConfig>;

    return Array.isArray(candidate.plugins) && Array.isArray(candidate.socialProviders);
};

/**
 * Normalize the parsed body. The server is trusted for shape but not for
 * completeness — an older `uiConfig()` may predate a field, and defaulting here
 * keeps the callers free of `?? false` noise.
 */
const normalize = (raw: DiscoveredConfig): DiscoveredConfig => {
    return {
        emailAndPassword: raw.emailAndPassword ?? true,
        organization: {
            enabled: raw.organization?.enabled ?? false,
            roles: raw.organization?.roles ?? false,
            teams: raw.organization?.teams ?? false,
        },
        plugins: raw.plugins,
        signUp: raw.signUp ?? true,
        socialProviders: raw.socialProviders,
    };
};

/**
 * Start (or join) discovery against `basePath`.
 *
 * Returns immediately with `status: "loading"`; subscribers are notified once
 * the request settles. Callers that never subscribe simply never see the
 * upgrade, which is the correct behaviour for a server-rendered first paint.
 */
const discoverAuthConfig = (basePath: string): DiscoveryHandle => {
    const url = `${basePath.endsWith("/") ? basePath.slice(0, -1) : basePath}/ui-config`;
    const existing = handles.get(url);

    if (existing) {
        return existing;
    }

    const store = createStore<DiscoveryState>({ status: "loading" });
    const handle: DiscoveryHandle = { getState: store.get, subscribe: store.subscribe };

    handles.set(url, handle);

    const fetcher = (globalThis as { fetch?: typeof fetch }).fetch;

    if (typeof fetcher !== "function") {
        store.update({ status: "unavailable" });

        return handle;
    }

    void (async () => {
        try {
            // `credentials: "include"` because the endpoint is same-origin with the
            // rest of better-auth and a cross-origin deployment needs the cookie to
            // be sent for the CORS preflight to match the other auth calls.
            const response = await fetcher(url, { credentials: "include", headers: { accept: "application/json" } });

            if (!response.ok) {
                store.update({ status: "unavailable" });

                return;
            }

            const body: unknown = await response.json();

            store.update(isConfig(body) ? { config: normalize(body), status: "ready" } : { status: "unavailable" });
        } catch {
            // Offline, CORS, a non-JSON body from a catch-all route — all the same
            // answer. The gate falls back to the client's own registration.
            store.update({ status: "unavailable" });
        }
    })();

    return handle;
};

/** Test seam: drop every cached request so the next call refetches. */
const resetAuthConfigDiscovery = (): void => {
    handles.clear();
};

export type { DiscoveredConfig, DiscoveredOrganization, DiscoveryHandle, DiscoveryState, DiscoveryStatus };
export { discoverAuthConfig, PLUGIN_ID_TO_FLOW, resetAuthConfigDiscovery };
