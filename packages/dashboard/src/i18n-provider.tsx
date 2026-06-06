import type { I18n } from "@lingui/core";
import type { ReactElement, ReactNode } from "react";
import { useMemo } from "react";

import type { DashboardCatalogs } from "./i18n-context.js";
import { createDashboardI18n, dashboardI18n, DashboardI18nContext } from "./i18n-context.js";

interface DashboardI18nProviderProps {
    /** Catalogs to register in addition to the built-in English one. */
    readonly catalogs?: DashboardCatalogs;
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
const resolveInstance = (i18n: I18n | undefined, locale: string | undefined, catalogs: DashboardCatalogs | undefined): I18n => {
    if (i18n !== undefined) {
        return i18n;
    }

    if (locale === undefined && catalogs === undefined) {
        return dashboardI18n;
    }

    return createDashboardI18n(locale, catalogs);
};

/**
 * Provides a dashboard-scoped Lingui instance to `useT`. Nesting is safe:
 * providers sharing the same instance resolve to the same context value.
 */
export const DashboardI18nProvider = ({ catalogs, children, i18n, locale }: DashboardI18nProviderProps): ReactElement => {
    const instance = useMemo(() => resolveInstance(i18n, locale, catalogs), [catalogs, i18n, locale]);

    return <DashboardI18nContext value={instance}>{children}</DashboardI18nContext>;
};

export type { DashboardI18nProviderProps };
