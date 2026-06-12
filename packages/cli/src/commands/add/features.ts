/**
 * The feature catalog shared by `cirrus init`'s post-scaffold offer and the
 * `cirrus add &lt;feature>` command. Each feature maps to one or more **registry
 * items** (resolved by `runAddCommand`), so there is a single install path —
 * the registry — behind both front doors.
 */
import type { SelectOption } from "@cirrus/config";

/** A registry item a feature can install. */
type FeatureItem = "auth" | "auth-auth0" | "auth-clerk" | "mail";

/** The auth-provider choices offered for `add auth` / the init auth prompt. Each value is a registry item name. */
const AUTH_PROVIDER_OPTIONS: ReadonlyArray<SelectOption<FeatureItem>> = [
    { description: "Email + password on better-auth (default)", label: "Email & password", value: "auth" },
    { description: "Clerk-hosted auth", label: "Clerk", value: "auth-clerk" },
    { description: "Auth0 (OIDC)", label: "Auth0", value: "auth-auth0" },
];

/** Default auth item when the provider prompt is skipped (non-interactive / `--yes`). */
const DEFAULT_AUTH_ITEM: FeatureItem = "auth";

/** A single-select prompt over the auth providers — `add`'s and the init offer's `select`/`deps.select` both satisfy this. */
type AuthProviderSelect = (
    message: string,
    options: ReadonlyArray<SelectOption<FeatureItem>>,
    settings?: { default?: FeatureItem },
) => Promise<FeatureItem | undefined>;

/**
 * Prompt for the auth provider, defaulting to email & password. Shared by
 * `cirrus add` and the init post-scaffold offer so the message, options, and
 * default can't drift between the two front doors.
 */
const promptAuthProvider = async (select: AuthProviderSelect): Promise<FeatureItem> =>
    (await select("Which auth provider?", AUTH_PROVIDER_OPTIONS, { default: DEFAULT_AUTH_ITEM })) ?? DEFAULT_AUTH_ITEM;

/** The transactional-email registry item (Cloudflare Email Workers + dev mail catcher). */
const EMAIL_ITEM: FeatureItem = "mail";

/**
 * A resolved `cirrus add` argument: either one of the friendly aliases (`auth`
 * prompts for a provider, `email` maps to the mail item) or a bare registry
 * item name passed straight through to `runAddCommand` (which validates it).
 */
type NormalizedFeature = { item: string; kind: "item" } | { kind: "auth" } | { kind: "email" };

/**
 * Normalize a `cirrus add` argument. The friendly aliases (`auth`, `email` /
 * `mail`) resolve to their dedicated flows; any other non-empty name is treated
 * as a bare registry item and handed to the registry as-is — it errors clearly
 * if unknown. Returns `undefined` only for an empty/whitespace argument.
 */
const normalizeFeature = (raw: string): NormalizedFeature | undefined => {
    const value = raw.trim();

    if (value === "") {
        return undefined;
    }

    const lower = value.toLowerCase();

    if (lower === "auth") {
        return { kind: "auth" };
    }

    if (lower === "email" || lower === "mail") {
        return { kind: "email" };
    }

    // Any other name is passed straight to the registry, which validates it
    // against the available items and errors if it's unknown.
    return { item: lower, kind: "item" };
};

export { AUTH_PROVIDER_OPTIONS, DEFAULT_AUTH_ITEM, EMAIL_ITEM, normalizeFeature, promptAuthProvider };
export type { FeatureItem, NormalizedFeature };
