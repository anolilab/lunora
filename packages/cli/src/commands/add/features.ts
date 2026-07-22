/**
 * The feature catalog shared by `lunora init`'s post-scaffold offer and the
 * `lunora add &lt;feature>` command. Each feature maps to one or more **registry
 * items** (resolved by `runAddCommand`), so there is a single install path —
 * the registry — behind both front doors.
 */
import type { SelectOption } from "@lunora/config";

/** The per-framework auth-UI registry items (`auth-ui` resolves to one of these). */
type AuthUiItem = "auth-ui-angular" | "auth-ui-react" | "auth-ui-solid" | "auth-ui-svelte" | "auth-ui-vue";

/** A registry item a feature can install. */
type FeatureItem = "auth" | "auth-auth0" | "auth-clerk" | AuthUiItem | "mail";

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
 * `lunora add` and the init post-scaffold offer so the message, options, and
 * default can't drift between the two front doors.
 */
const promptAuthProvider = async (select: AuthProviderSelect): Promise<FeatureItem> =>
    (await select("Which auth provider?", AUTH_PROVIDER_OPTIONS, { default: DEFAULT_AUTH_ITEM })) ?? DEFAULT_AUTH_ITEM;

/** The transactional-email registry item (Cloudflare Email Workers + dev mail catcher). */
const EMAIL_ITEM: FeatureItem = "mail";

/** The framework choices offered when `add auth-ui`'s framework can't be auto-detected. */
const AUTH_UI_OPTIONS: ReadonlyArray<SelectOption<AuthUiItem>> = [
    { description: "Next, react-router, TanStack Start, Astro islands", label: "React", value: "auth-ui-react" },
    { description: "Nuxt, Vue + Vite", label: "Vue", value: "auth-ui-vue" },
    { description: "SvelteKit, Svelte + Vite", label: "Svelte", value: "auth-ui-svelte" },
    { description: "TanStack Start Solid, Solid + Vite", label: "Solid", value: "auth-ui-solid" },
    { description: "Analog", label: "Angular", value: "auth-ui-angular" },
];

/** Default auth-UI item when the framework can't be detected and no prompt runs. */
const DEFAULT_AUTH_UI_ITEM: AuthUiItem = "auth-ui-react";

/**
 * Detect which auth-UI item fits a project from its package.json dependencies.
 * The Lunora framework adapter dep wins; a bare framework (or its meta-framework)
 * is the fallback. Returns `undefined` when nothing matches (caller then prompts).
 */
const detectAuthUiItem = (dependencies: Readonly<Record<string, string>>): AuthUiItem | undefined => {
    const has = (name: string): boolean => Object.hasOwn(dependencies, name);

    if (has("@lunora/react")) {
        return "auth-ui-react";
    }

    if (has("@lunora/vue")) {
        return "auth-ui-vue";
    }

    if (has("@lunora/svelte")) {
        return "auth-ui-svelte";
    }

    if (has("@lunora/solid")) {
        return "auth-ui-solid";
    }

    if (has("@lunora/angular")) {
        return "auth-ui-angular";
    }

    if (has("react") || has("next")) {
        return "auth-ui-react";
    }

    if (has("vue") || has("nuxt")) {
        return "auth-ui-vue";
    }

    if (has("svelte") || has("@sveltejs/kit")) {
        return "auth-ui-svelte";
    }

    if (has("solid-js")) {
        return "auth-ui-solid";
    }

    if (has("@angular/core")) {
        return "auth-ui-angular";
    }

    return undefined;
};

/**
 * A resolved `lunora add` argument: either one of the friendly aliases (`auth`
 * prompts for a provider, `email` maps to the mail item) or a bare registry
 * item name passed straight through to `runAddCommand` (which validates it).
 */
type NormalizedFeature = { item: string; kind: "item" } | { kind: "auth" } | { kind: "auth-ui" } | { kind: "email" };

/**
 * Normalize a `lunora add` argument. The friendly aliases (`auth`, `email` /
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

    // `auth-ui` resolves to a per-framework item (auth-ui-react|vue|…) — matched
    // before `auth` so it doesn't fall through to the provider prompt.
    if (lower === "auth-ui" || lower === "auth-ui-") {
        return { kind: "auth-ui" };
    }

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

export { AUTH_PROVIDER_OPTIONS, AUTH_UI_OPTIONS, DEFAULT_AUTH_ITEM, DEFAULT_AUTH_UI_ITEM, detectAuthUiItem, EMAIL_ITEM, normalizeFeature, promptAuthProvider };
export type { AuthUiItem, FeatureItem, NormalizedFeature };
