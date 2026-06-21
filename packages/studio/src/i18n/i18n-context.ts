import type { I18n, Messages } from "@lingui/core";
import { setupI18n } from "@lingui/core";
import { compileMessage } from "@lingui/message-utils/compileMessage";
import type { Context } from "react";
import { createContext, use } from "react";

import type { MessageId } from "../locales/en";
import { messages as enMessages } from "../locales/en";

/** The locale the studio ships with and falls back to. */
const DEFAULT_LOCALE = "en";

/**
 * Locale code to catalog. Each catalog maps an English source string (which
 * doubles as the message id) to its translation. English ships empty: Lingui
 * compiles the id verbatim when a translation is missing, so the source strings
 * render as-is. To add a language, register `{ "Some English text": "…" }`.
 */
type StudioCatalogs = Readonly<Record<string, Messages>>;

/**
 * Translate function: `t("Clear")` or `t("{title} failed", { title })`.
 *
 * `id` is constrained to a known {@link MessageId}, so a typo is a compile error.
 * The interpolation `values` stay loosely typed: mapping each id to its exact
 * placeholder set isn't worth the machinery for the handful of interpolated
 * strings, so a wrong or missing value key isn't caught at this boundary.
 */
type TFunction = (id: MessageId, values?: Record<string, unknown>) => string;

const BUILTIN_CATALOGS: StudioCatalogs = { en: enMessages };

/**
 * Build a studio-scoped Lingui instance. We deliberately use `@lingui/core`'s
 * `setupI18n` (a fresh instance) rather than the global singleton so the
 * studio can never clobber — or be clobbered by — a host app that also uses
 * Lingui.
 *
 * The message compiler is installed explicitly. `@lingui/core` only auto-installs
 * it when `NODE_ENV !== "production"`, but the studio ships as a library and
 * relies on the compiler at runtime to interpolate uncompiled source strings
 * (e.g. `t("{title} failed", { title })`). Without this, a consumer's production
 * build would render `{title}` literally and `console.warn` on every `t(...)`.
 *
 * Pass extra `catalogs` to ship more locales; unknown `locale` codes fall back
 * to `DEFAULT_LOCALE`.
 */
const createStudioI18n = (locale: string = DEFAULT_LOCALE, catalogs: StudioCatalogs = BUILTIN_CATALOGS): I18n => {
    const instance = setupI18n();

    instance.setMessagesCompiler(compileMessage);

    for (const [code, catalog] of Object.entries(catalogs)) {
        instance.load(code, catalog);
    }

    instance.activate(catalogs[locale] === undefined ? DEFAULT_LOCALE : locale);

    return instance;
};

/**
 * Shared default instance. Backs the i18n context's default value so the
 * composable studio and individual exported panels resolve their strings even
 * when rendered without `StudioI18nProvider` (e.g. in tests, or a host's own
 * admin UI). English-only, so it renders source strings as-is.
 */
const studioI18n: I18n = createStudioI18n();

// Our own context (not `@lingui/react`'s) so `useT` has a sane default and never
// throws when a panel is rendered outside the provider. `@lingui/core` is the
// only Lingui runtime the studio pulls in.
const StudioI18nContext: Context<I18n> = createContext<I18n>(studioI18n);

/**
 * Hook returning a `t` bound to the nearest `StudioI18nProvider` (or the
 * shared instance when there's none). This is the runtime stand-in for Lingui's
 * `t` macro — the studio builds with esbuild and tests under Vite 8/Rolldown,
 * neither of which runs Lingui's Babel macro transform, so call sites pass the
 * English string as the id directly.
 */
const useT = (): TFunction => {
    const i18n = use(StudioI18nContext);

    return (id, values) => i18n._(id, values);
};

export { createStudioI18n, DEFAULT_LOCALE, studioI18n, StudioI18nContext, useT };
export type { StudioCatalogs, TFunction };

export { type MessageId } from "../locales/en";
