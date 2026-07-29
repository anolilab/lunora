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
 * attacker and useless to a login form. `AuthAdmin.config` still returns
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
import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { getAuthTables } from "better-auth/db";

/** Organization sub-features a UI branches on. */
interface UiConfigOrganization {
    /** Whether an ordinary user may create one at all. */
    allowUserToCreate: boolean;
    enabled: boolean;
    /** Max invitations per organization, when configured. */
    invitationLimit?: number;
    /** Max organizations one user may belong to, when configured. */
    limit?: number;
    /** Max members per organization, when configured. */
    membershipLimit?: number;
    /** Custom roles / dynamic access control are configured. */
    roles: boolean;
    /** Teams are enabled. */
    teams: boolean;
}

/** The public payload `GET {basePath}/ui-config` returns. */
interface UiConfigPayload {
    /** Whether email + password sign-in is enabled. */
    emailAndPassword: boolean;
    /** Absent when `expose.organization` is false — see {@link UiConfigOptions.expose}. */
    organization?: UiConfigOrganization;
    /** Enabled better-auth plugin ids, sorted. Absent when not disclosed. */
    plugins?: string[];
    /** Whether self-serve sign-up is open. */
    signUp: boolean;
    /** Configured social/OAuth provider ids, sorted. Absent when not disclosed. */
    socialProviders?: string[];
}

/** Options for {@link uiConfig}. */
interface UiConfigOptions {
    /**
     * Omit fields from the payload. Everything is published by default; set a
     * key to `false` for a deployment that would rather not enumerate, say, its
     * plugin set to anonymous callers.
     *
     * The field is **omitted, not emptied**. An empty `plugins: []` is
     * indistinguishable from "this deployment runs no plugins", and the client
     * ANDs the server's answer with its own registration — so emptying it would
     * silently switch off every gated card instead of merely withholding the
     * list. Absent means "not disclosed", and the client falls back to what
     * `client.ts` registered.
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
    plugins?: { id: string; options?: OrganizationLimits }[];
    socialProviders?: Record<string, unknown>;
}

/**
 * The organization plugin's numeric limits.
 *
 * Published because a client cannot derive them: better-auth enforces them
 * server-side and exposes no endpoint that reports them, so a UI either hides
 * the limit until the user hits it or guesses. They are configuration, not
 * secrets — the user discovers each one by being refused.
 */
interface OrganizationLimits {
    allowUserToCreateOrganization?: boolean | ((...arguments_: never[]) => unknown);
    invitationLimit?: number;
    membershipLimit?: number;
    organizationLimit?: number;
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
    const organizationOptions = (options.plugins ?? []).find((plugin) => plugin.id === "organization")?.options ?? {};
    // A function form is a per-request decision this endpoint cannot evaluate,
    // so it reports "allowed" and lets the server refuse — the alternative is a
    // create button hidden from everyone because one user might be refused.
    const allowUserToCreate =
        typeof organizationOptions.allowUserToCreateOrganization === "function" ? true : organizationOptions.allowUserToCreateOrganization !== false;

    const organization: UiConfigOrganization = {
        allowUserToCreate,
        enabled: ids.has("organization"),
        invitationLimit: organizationOptions.invitationLimit,
        limit: organizationOptions.organizationLimit,
        membershipLimit: organizationOptions.membershipLimit,
        roles: Boolean(tables["organizationRole"]),
        teams: Boolean(tables["team"]),
    };

    return {
        emailAndPassword,
        // `disableSignUp` only means anything when the password provider is on;
        // an OAuth-only deployment has no sign-up form to gate.
        signUp: emailAndPassword && options.emailAndPassword?.disableSignUp !== true,
        // Each of these is spread in only when disclosed, so an undisclosed
        // field is genuinely absent from the JSON rather than present-and-empty.
        ...(expose.organization === false ? {} : { organization }),
        ...(expose.plugins === false ? {} : { plugins: sorted(ids) }),
        ...(expose.socialProviders === false
            ? {}
            : { socialProviders: sorted(new Set([...Object.keys(options.socialProviders ?? {}), ...(pluginOptions.extraProviders ?? [])])) }),
    };
};

/** Build the endpoint, so {@link uiConfig} stays a plain object literal. */
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
        (context: unknown) => {
            // better-auth types the handler context generically over the whole
            // endpoint map, which is not nameable here. `unknown` accepts that
            // type, and the narrowing states exactly what is read — both fields
            // are stable public API.
            const endpointContext = context as { context: { options: ResolvedAuthOptions }; json: (body: UiConfigPayload) => unknown };

            return Promise.resolve(endpointContext.json(deriveUiConfig(endpointContext.context.options, options)));
        },
    );

/**
 * A better-auth server plugin publishing {@link UiConfigPayload} at
 * `GET {basePath}/ui-config`.
 *
 * There is no client half: the payload is fetched with a plain `fetch` by
 * whatever renders your auth screens, so it works before a client exists and
 * from a framework this package knows nothing about.
 *
 * The return type is better-auth's own `BetterAuthPlugin` rather than the precise
 * shape of the endpoint map. That is deliberate: `createAuthEndpoint`'s inferred
 * type is anonymous, and naming it is the difference between a build that emits
 * declarations and one that fails only in the bundler — after `tsc` and the
 * tests have both gone green. `BetterAuthPlugin` is what `createAuth({ plugins })`
 * consumes anyway.
 */
const uiConfig = (options: UiConfigOptions = {}): BetterAuthPlugin => {
    return {
        endpoints: { getUiConfig: createUiConfigEndpoint(options) },
        id: "lunora-ui-config",
    };
};

export type { OrganizationLimits, UiConfigOptions, UiConfigOrganization, UiConfigPayload };
export { deriveUiConfig, uiConfig };
