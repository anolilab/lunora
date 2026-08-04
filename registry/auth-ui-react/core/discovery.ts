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
    /** Whether an ordinary user may create one at all. */
    allowUserToCreate: boolean;
    enabled: boolean;
    invitationLimit?: number;
    /** Max organizations one user may belong to, when the server sets one. */
    limit?: number;
    membershipLimit?: number;
    roles: boolean;
    teams: boolean;
}

/** The payload `GET {basePath}/ui-config` returns (see `@lunora/auth`'s `uiConfig`). */
interface DiscoveredConfig {
    emailAndPassword: boolean;
    /** Absent when the server chose not to disclose it — see `uiConfig`'s `expose`. */
    organization?: DiscoveredOrganization;
    /** Absent when not disclosed; that is *not* the same as "no plugins". */
    plugins?: ReadonlyArray<string>;
    signUp: boolean;
    /** Absent when not disclosed. */
    socialProviders?: ReadonlyArray<string>;
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
    "oauth-provider": "oauthProvider",
    "one-tap": "oneTap",
    organization: "organization",
    passkey: "passkey",
    "phone-number": "phoneNumber",
    "two-factor": "twoFactor",
    username: "username",
};

/**
 * One in-flight request per endpoint, shared by every provider on the page.
 *
 * A *failed* lookup is evicted rather than cached, so a later mount retries
 * instead of inheriting one offline moment for the life of the page. Note the
 * limit: providers already mounted keep the handle they were given and stay
 * `unavailable` until they remount. A successful answer stays cached, because
 * it cannot change.
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

    /*
     * The two booleans are the shape marker, not `plugins`: a deployment may
     * withhold the plugin list, and requiring it here would make a legitimate
     * answer look like an unrelated endpoint.
     *
     * The arrays are still checked *when present*, because nothing downstream
     * re-checks them: a `plugins: 42` would reach `for (const id of plugins)`
     * and throw inside the provider's render rather than degrading.
     */
    const arrayOrAbsent = (candidateValue: unknown): boolean => candidateValue === undefined || Array.isArray(candidateValue);

    return (
        typeof candidate.signUp === "boolean" &&
        typeof candidate.emailAndPassword === "boolean" &&
        arrayOrAbsent(candidate.plugins) &&
        arrayOrAbsent(candidate.socialProviders)
    );
};

/**
 * The body as `isConfig` has proved it: the two booleans are the shape marker,
 * so they are present; everything else is optional because the server may have
 * withheld it (`expose`) or predate it.
 */
type DiscoveredPayload = Partial<Omit<DiscoveredConfig, "emailAndPassword" | "organization" | "signUp">> &
    Pick<DiscoveredConfig, "emailAndPassword" | "signUp"> & { organization?: Partial<DiscoveredOrganization> };

/**
 * Normalize the parsed body.
 *
 * Only the optional halves need defaulting: `emailAndPassword` and `signUp` are
 * what `isConfig` checks for, so by the time this runs they are booleans. The
 * two arrays and `organization` are the genuinely absent-able ones — withheld by
 * `expose`, or predating a field — and stay `undefined` rather than defaulted,
 * because the resolver has to tell "not disclosed" from "disclosed as empty".
 */
const normalize = (raw: DiscoveredPayload): DiscoveredConfig => {
    return {
        emailAndPassword: raw.emailAndPassword,
        // An undisclosed field stays undefined so the resolver can tell it apart
        // from a disclosed-but-empty one and fall back to the client's own answer.
        organization:
            raw.organization === undefined
                ? undefined
                : {
                      allowUserToCreate: raw.organization.allowUserToCreate ?? true,
                      enabled: raw.organization.enabled ?? false,
                      invitationLimit: raw.organization.invitationLimit,
                      limit: raw.organization.limit,
                      membershipLimit: raw.organization.membershipLimit,
                      roles: raw.organization.roles ?? false,
                      teams: raw.organization.teams ?? false,
                  },
        plugins: raw.plugins,
        signUp: raw.signUp,
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
        handles.delete(url);
        store.update({ status: "unavailable" });

        return handle;
    }

    /*
     * Resolve a root-relative path against the origin ourselves rather than
     * leaving it to `fetch`.
     *
     * Only a browser's `fetch` resolves relative URLs; Node's rejects them with
     * `ERR_INVALID_URL`, and a jsdom-style environment has a `location` without
     * having taught `fetch` about it — so "there is an origin" and "fetch can
     * use it" are different questions. With no origin at all (real SSR) there is
     * nothing to resolve against and discovery simply doesn't run, which is the
     * right answer: the flags fall back to the client's registration.
     */
    const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
    const hasOrigin = origin !== undefined && origin !== "";
    let requestUrl: string | undefined = url;

    if (url.startsWith("/")) {
        requestUrl = hasOrigin ? `${origin}${url}` : undefined;
    }

    if (requestUrl === undefined) {
        handles.delete(url);
        store.update({ status: "unavailable" });

        return handle;
    }

    /** Report failure and drop the cache entry, so a later mount can retry. */
    const unavailable = (): void => {
        handles.delete(url);
        store.update({ status: "unavailable" });
    };

    void (async () => {
        try {
            // `credentials: "include"` because the endpoint is same-origin with the
            // rest of better-auth and a cross-origin deployment needs the cookie to
            // be sent for the CORS preflight to match the other auth calls.
            const response = await fetcher(requestUrl, { credentials: "include", headers: { accept: "application/json" } });

            if (!response.ok) {
                unavailable();

                return;
            }

            const body: unknown = await response.json();

            if (isConfig(body)) {
                store.update({ config: normalize(body), status: "ready" });

                return;
            }

            unavailable();
        } catch {
            // Offline, CORS, a non-JSON body from a catch-all route — all the same
            // answer. The gate falls back to the client's own registration.
            unavailable();
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
