import type { I18n } from "@lingui/core";
import type { ReactElement, ReactNode } from "react";
import { useMemo } from "react";

import type { StudioCatalogs } from "./i18n-context.js";
import { createStudioI18n, studioI18n, StudioI18nContext } from "./i18n-context.js";

interface StudioI18nProviderProps {
    /** Catalogs to register in addition to the built-in English one. */
    readonly catalogs?: StudioCatalogs;
    readonly children: ReactNode;
    /** Reuse an existing instance (wins over `locale`/`catalogs`). */
    readonly i18n?: I18n;
    /** Active locale; ignored when `i18n` is supplied. Defaults to `en`. */
    readonly locale?: string;
}

/**
 * Resolve which Lingui instance backs the provider, in precedence order: an
 * explicit `i18n` instance wins; else the shared default singleton when no
 * overrides are given (so unconfigured providers share one instance and nest
 * harmlessly); else a fresh instance for the requested `locale`/`catalogs`.
 */
const resolveInstance = (i18n: I18n | undefined, locale: string | undefined, catalogs: StudioCatalogs | undefined): I18n => {
    if (i18n !== undefined) {
        return i18n;
    }

    if (locale === undefined && catalogs === undefined) {
        return studioI18n;
    }

    return createStudioI18n(locale, catalogs);
};

/**
 * Provides a studio-scoped Lingui instance to `useT`. Nesting is safe:
 * providers sharing the same instance resolve to the same context value.
 */
export const StudioI18nProvider = ({ catalogs, children, i18n, locale }: StudioI18nProviderProps): ReactElement => {
    const instance = useMemo(() => resolveInstance(i18n, locale, catalogs), [catalogs, i18n, locale]);

    return <StudioI18nContext value={instance}>{children}</StudioI18nContext>;
};

export type { StudioI18nProviderProps };
