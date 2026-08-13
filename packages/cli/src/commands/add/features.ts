/**
 * The feature catalog shared by `lunora init`'s post-scaffold offer and the
 * `lunora add <feature>` command. Each feature maps to one or more **registry
 * items** (resolved by `runAddCommand`), so there is a single install path —
 * the registry — behind both front doors.
 */
import type { SelectOption } from "@lunora/config";

/**
 * The per-framework auth-UI registry items (`auth-ui` resolves to one of these).
 *
 * Solid has two because these are copy-in source files, not a compiled package:
 * the 1.x and 2.0 spellings are mutually exclusive in the source itself, so the
 * two majors get one item each and {@link detectAuthUiItem} picks.
 */
type AuthUiItem = "auth-ui-angular" | "auth-ui-react" | "auth-ui-solid" | "auth-ui-solid-v2" | "auth-ui-svelte" | "auth-ui-vue";

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
    { description: "TanStack Start Solid, Solid 1.x + Vite", label: "Solid", value: "auth-ui-solid" },
    { description: "Solid 2.0 + Vite (@solidjs/web)", label: "Solid 2", value: "auth-ui-solid-v2" },
    { description: "Analog", label: "Angular", value: "auth-ui-angular" },
];

/** Default auth-UI item when the framework can't be detected and no prompt runs. */
const DEFAULT_AUTH_UI_ITEM: AuthUiItem = "auth-ui-react";

/**
 * Is this a React Native (Expo) project? Every auth-UI port renders DOM — `div`,
 * `form`, `input`, and a stylesheet of `lunora-auth-*` classes — so the React
 * payload would type-check and then render nothing on a native target. Detected
 * ahead of the framework match because an Expo app also depends on `react`, which
 * would otherwise silently resolve to `auth-ui-react`.
 */
const isReactNativeProject = (dependencies: Readonly<Record<string, string>>): boolean =>
    Object.hasOwn(dependencies, "react-native") || Object.hasOwn(dependencies, "@lunora/react-native") || Object.hasOwn(dependencies, "expo");

/** Matches the leading major of a semver range (`^2.0.0-rc.0` → `2`). Hoisted so it isn't recompiled per call. */
const LEADING_MAJOR = /^\D*(\d+)\./;

/** Leading major of a semver range like `^2.0.0-rc.0`, or `undefined` when it can't be read. */
const leadingMajor = (range: string | undefined): number | undefined => {
    const match = LEADING_MAJOR.exec(range?.trim() ?? "");

    return match ? Number(match[1]) : undefined;
};

/**
 * Is this a Solid **2.x** project?
 *
 * `@lunora/solid` spans both Solid majors, but the auth-UI payload cannot: those
 * screens are user-owned *source*, and the 1.x spelling
 * (`import type { JSX } from "solid-js"`, `onMount`, camelCase DOM attributes)
 * is exactly what Solid 2 removed or renamed. So each major has its own item and
 * this is the fork between them — `auth-ui-solid-v2` here, `auth-ui-solid`
 * otherwise.
 *
 * Detected from `@solidjs/web` (a package that exists only on the 2.x line) or
 * an explicit `solid-js` major, so a project cannot land here by accident.
 */
const isSolid2Project = (dependencies: Readonly<Record<string, string>>): boolean =>
    Object.hasOwn(dependencies, "@solidjs/web") || (leadingMajor(dependencies["solid-js"]) ?? 0) >= 2;

/**
 * Detect which auth-UI item fits a project from its package.json dependencies.
 * The Lunora framework adapter dep wins; a bare framework (or its meta-framework)
 * is the fallback. Returns `undefined` when nothing matches (caller then prompts)
 * — including for React Native, which has no DOM to render these screens into;
 * callers gate on {@link isReactNativeProject} first so that case gets its own
 * message rather than the generic "couldn't detect your framework".
 */
const detectAuthUiItem = (dependencies: Readonly<Record<string, string>>): AuthUiItem | undefined => {
    const has = (name: string): boolean => Object.hasOwn(dependencies, name);

    if (isReactNativeProject(dependencies)) {
        return undefined;
    }

    // Ahead of every framework match: a Solid 2 project also has `solid-js` and
    // `@lunora/solid`, which would otherwise resolve to the Solid 1.x payload.
    if (isSolid2Project(dependencies)) {
        return "auth-ui-solid-v2";
    }

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

export {
    AUTH_PROVIDER_OPTIONS,
    AUTH_UI_OPTIONS,
    DEFAULT_AUTH_ITEM,
    DEFAULT_AUTH_UI_ITEM,
    detectAuthUiItem,
    EMAIL_ITEM,
    isReactNativeProject,
    isSolid2Project,
    normalizeFeature,
    promptAuthProvider,
};
export type { AuthUiItem, FeatureItem, NormalizedFeature };
