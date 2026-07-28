/**
 * A public, unauthenticated description of what this deployment's auth actually
 * supports — so an auth UI can configure itself instead of being told twice.
 *
 * # Why this exists
 *
 * A better-auth client is a dynamic-path `Proxy`: `client.magicLink.send` is a
 * function whether or not the magic-link plugin is installed, and so is
 * `client.notAPlugin.notAMethod`. There is nothing on the client to probe, in
 * either direction. So every auth UI in this ecosystem makes you restate your
 * plugin set a second time, client-side, and drift between the two lists is a
 * class of bug that only shows up as a card that silently isn't there.
 *
 * The server already knows. `betterAuth()` resolves `plugins` and
 * `socialProviders` into `$context.options`; this endpoint publishes the part of
 * that a sign-in screen needs.
 *
 * # What it exposes, and why that is safe
 *
 * Only facts a sign-in page reveals by existing: which providers have buttons,
 * whether the password form is there, whether sign-up is open. Plugin ids are
 * already inferable by probing routes (an installed plugin's endpoint answers
 * 400/401, a missing one 404), and the client bundle names them anyway.
 *
 * Deliberately **not** exposed: the session policy, the rate-limit policy, user
 * field schemas, and anything under `secret`. Those are genuinely useful to an
 * attacker and useless to a login form. {@link AuthAdmin.config} still returns
 * them — it sits behind your own authorization.
 *
 * # Wiring
 *
 * ```ts
 * import { createAuth } from "@lunora/auth";
 * import { organization, twoFactor, uiConfig } from "@lunora/auth/plugins";
 *
 * export const auth = createAuth({
 *     database: env.DB,
 *     secret: env.AUTH_SECRET,
 *     plugins: [organization(), twoFactor(), uiConfig()],
 * });
 * ```
 *
 * `GET /api/auth/ui-config` then answers, and `lunora/auth-ui`'s provider picks
 * it up with no client configuration at all.
 */
import { createAuthEndpoint } from "better-auth/api";
import { getAuthTables } from "better-auth/db";

/** Organization sub-features a UI branches on. */
interface UiConfigOrganization {
    enabled: boolean;
    /** Custom roles / dynamic access control are configured. */
    roles: boolean;
    /** Teams are enabled. */
    teams: boolean;
}

/** The public payload `GET {basePath}/ui-config` returns. */
interface UiConfigPayload {
    /** Whether email + password sign-in is enabled. */
    emailAndPassword: boolean;
    organization: UiConfigOrganization;
    /** Enabled better-auth plugin ids, sorted. */
    plugins: string[];
    /** Whether self-serve sign-up is open. */
    signUp: boolean;
    /** Configured social/OAuth provider ids, sorted. */
    socialProviders: string[];
}

/** Options for {@link uiConfig}. */
interface UiConfigOptions {
    /**
     * Drop fields from the payload. Everything is published by default; set a
     * key to `false` for a deployment that would rather not enumerate, say, its
     * plugin set to anonymous callers.
     */
    expose?: {
        organization?: boolean;
        plugins?: boolean;
        socialProviders?: boolean;
    };

    /**
     * Extra provider ids to advertise beyond `socialProviders`. Providers wired
     * through the `genericOAuth` plugin live in that plugin's own options rather
     * than in `socialProviders`, so they cannot be derived here — list them if
     * you want buttons for them.
     */
    extraProviders?: string[];

    /**
     * Path the endpoint mounts at, relative to the auth basePath.
     *
     * @default "/ui-config"
     */
    path?: string;
}

const sorted = (values: Iterable<string>): string[] => [...values].toSorted((a, b) => a.localeCompare(b));

/**
 * The shape of the resolved better-auth options this plugin reads. Written by
 * hand rather than imported: better-auth's `BetterAuthOptions` is generic over
 * the plugin array, so naming it here would drag that inference into the
 * endpoint handler for no gain — we read four fields, all optional.
 */
interface ResolvedAuthOptions {
    emailAndPassword?: { disableSignUp?: boolean; enabled?: boolean };
    plugins?: { id: string }[];
    socialProviders?: Record<string, unknown>;
}

/** Build the payload from resolved better-auth options. Exported for tests. */
const deriveUiConfig = (options: ResolvedAuthOptions, pluginOptions: UiConfigOptions = {}): UiConfigPayload => {
    const expose = pluginOptions.expose ?? {};
    const ids = new Set((options.plugins ?? []).map((plugin) => plugin.id));
    const emailAndPassword = options.emailAndPassword?.enabled ?? false;

    // Teams and custom roles are *options* of the one `organization` plugin, not
    // plugins of their own, so the id set can't answer this. Each does declare a
    // table, though, and the resolved table map is derivable from options —
    // which is how `AuthAdmin.config` reads the same two flags.
    const tables = getAuthTables(options as Parameters<typeof getAuthTables>[0]);
    const organization: UiConfigOrganization = {
        enabled: ids.has("organization"),
        roles: Boolean(tables["organizationRole"]),
        teams: Boolean(tables["team"]),
    };

    return {
        emailAndPassword,
        // `disableSignUp` only means anything when the password provider is on;
        // an OAuth-only deployment has no sign-up form to gate.
        organization: expose.organization === false ? { enabled: false, roles: false, teams: false } : organization,
        plugins: expose.plugins === false ? [] : sorted(ids),
        signUp: emailAndPassword && options.emailAndPassword?.disableSignUp !== true,
        socialProviders:
            expose.socialProviders === false ? [] : sorted(new Set([...Object.keys(options.socialProviders ?? {}), ...(pluginOptions.extraProviders ?? [])])),
    };
};

/**
 * The single endpoint, split out so {@link uiConfig} can name its own return
 * type without restating better-auth's deeply-generic endpoint type — which does
 * not survive being widened to its defaults (`StrictEndpoint<…, EndpointOptions>`
 * narrows `method` to the union of every verb and stops accepting a `"GET"`).
 */
const createUiConfigEndpoint = (options: UiConfigOptions) =>
    createAuthEndpoint(
        options.path ?? "/ui-config",
        {
            metadata: {
                openapi: {
                    description: "Public description of the enabled auth plugins and social providers.",
                    responses: { "200": { description: "The UI configuration." } },
                },
            },
            method: "GET",
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- better-auth types the handler context generically over the whole endpoint map; the two fields read here are stable public API.
        (context: any) => Promise.resolve(context.json(deriveUiConfig(context.context.options as ResolvedAuthOptions, options))),
    );

/**
 * better-auth server plugin publishing {@link UiConfigPayload} at
 * `GET {basePath}/ui-config`.
 *
 * There is no client half: the payload is fetched with a plain `fetch` by
 * whatever renders your auth screens, so it works before a client exists and
 * from a framework this package knows nothing about.
 */
const uiConfig = (options: UiConfigOptions = {}): { endpoints: { getUiConfig: ReturnType<typeof createUiConfigEndpoint> }; id: string } => {
    return {
        endpoints: { getUiConfig: createUiConfigEndpoint(options) },
        id: "lunora-ui-config",
    };
};

export type { UiConfigOptions, UiConfigOrganization, UiConfigPayload };
export { deriveUiConfig, uiConfig };
