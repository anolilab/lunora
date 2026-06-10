import { useCirrus } from "@cirrus/react";
import type { AnyApiReferenceConfiguration } from "@scalar/api-reference-react";
import { ApiReferenceReact } from "@scalar/api-reference-react";
import type { ReactElement } from "react";
import { useCallback, useMemo, useSyncExternalStore } from "react";

import { EmptyState } from "./components/ui/empty-state";
import { Skeleton } from "./components/ui/skeleton";
import { useT } from "./i18n-context";
import type { SpecFetchState } from "./use-admin-spec";
import { useAdminSpec } from "./use-admin-spec";

interface ApiReferencePanelProps {
    /**
     * Inline OpenAPI document. When supplied the panel renders it directly and
     * skips the fetch — used by the mock harness and by hosts that already hold
     * the generated spec. When omitted the panel fetches the worker's
     * admin-gated `GET /_cirrus/admin/openapi` endpoint via the client.
     */
    readonly spec?: unknown;
}

/** The OpenAPI document shape the panel renders (only the field it inspects). */
type OpenApiDocument = Record<string, unknown>;

/** A spec with no `paths` (or an empty map) is the worker's "not configured" sentinel. */
const isEmptySpec = (spec: OpenApiDocument): boolean => {
    const { paths } = spec;

    return paths === undefined || (typeof paths === "object" && paths !== null && Object.keys(paths).length === 0);
};

/** Classify a resolved spec object into the `ready`/`empty` terminal states (see {@link useAdminSpec}). */
const classifySpec = (spec: unknown): SpecFetchState<OpenApiDocument> => {
    const document = spec as OpenApiDocument;

    return isEmptySpec(document) ? { kind: "empty" } : { kind: "ready", spec: document };
};

/**
 * CSS bridging Scalar's design tokens onto the studio's Tailwind theme variables
 * (`packages/studio/src/theme.css`). Scalar is configured with `theme: "none"`
 * so these custom properties win; the values reference the same `--background` /
 * `--foreground` / `--primary` / `--border` tokens the rest of the studio uses,
 * so the reference re-themes automatically in both light and dark mode (the
 * studio flips a `.dark` class on an ancestor, which retargets those tokens).
 */
const SCALAR_THEME_CSS = `
.scalar-app {
    /* Fill the bounded panel viewport so Scalar runs its own internal layout —
       a sticky operation sidebar + an independently scrolling content column —
       instead of growing the page and scrolling its sidebar out of view. */
    height: 100%;
    --scalar-font: inherit;
    --scalar-background-1: var(--background);
    --scalar-background-2: var(--sidebar);
    --scalar-background-3: var(--muted);
    --scalar-background-accent: var(--accent);
    --scalar-color-1: var(--foreground);
    --scalar-color-2: var(--muted-foreground);
    --scalar-color-3: var(--muted-foreground);
    --scalar-color-accent: var(--primary);
    --scalar-border-color: var(--border);
    --scalar-radius: var(--radius);
    --scalar-button-1: var(--primary);
    --scalar-button-1-color: var(--primary-foreground);
}
.scalar-api-reference {
    background: var(--background);
}
`;

/** Read the studio's current dark state — a `.dark` class on the document root or body. `false` without a DOM. */
const readDark = (): boolean => "document" in globalThis && (document.documentElement.classList.contains("dark") || document.body.classList.contains("dark"));

/**
 * Subscribe to studio theme changes: the studio flips a `.dark` class on an
 * ancestor, so watch class mutations on the document root and body. Returns a
 * no-op unsubscribe without a DOM (SSR / tests).
 */
const subscribeDark = (onChange: () => void): (() => void) => {
    if (!("document" in globalThis)) {
        return () => {};
    }

    const observer = new MutationObserver(onChange);

    observer.observe(document.documentElement, { attributeFilter: ["class"], attributes: true });
    observer.observe(document.body, { attributeFilter: ["class"], attributes: true });

    return () => {
        observer.disconnect();
    };
};

/**
 * Track dark mode the way the studio expresses it (a `.dark` ancestor class),
 * live-updating when the studio's theme toggle flips it. Uses `useSyncExternalStore`
 * so the value is read from the DOM rather than mirrored into effect-driven state.
 */
const useStudioDarkMode = (): boolean => useSyncExternalStore(subscribeDark, readDark, () => false);

/**
 * In-studio OpenAPI reference: renders the generated OpenAPI 3.1 document with
 * Scalar's interactive API reference (operation browser, schema/param tables, and
 * a "try it" console). The spec comes from an inline {@link ApiReferencePanelProps.spec}
 * prop, or — by default — the worker's admin-gated `GET /_cirrus/admin/openapi`
 * endpoint fetched through the client.
 *
 * This is the reference-doc complement to the copy-paste snippet browser
 * (`api-docs-panel`); both live under the studio's API tab.
 */
const ApiReferencePanel = ({ spec: inlineSpec }: ApiReferencePanelProps): ReactElement => {
    const t = useT();
    const client = useCirrus();
    const dark = useStudioDarkMode();

    const fetchOpenApi = useCallback(() => client.fetchOpenApi(), [client]);
    const state = useAdminSpec<OpenApiDocument>(inlineSpec, fetchOpenApi, classifySpec);

    const configuration = useMemo<AnyApiReferenceConfiguration | undefined>(() => {
        if (state.kind !== "ready") {
            return undefined;
        }

        return {
            _integration: "react",
            content: state.spec,
            customCss: SCALAR_THEME_CSS,
            // The studio owns the theme toggle, so hide Scalar's and force the
            // mode to match the studio's current `.dark` state.
            darkMode: dark,
            forceDarkModeState: dark ? "dark" : "light",
            hideDarkModeToggle: true,
            // `none` defers all colours to `customCss` above so the reference
            // matches the studio's tokens rather than Scalar's stock palette.
            theme: "none",
            withDefaultFonts: false,
        };
    }, [state, dark]);

    if (state.kind === "loading") {
        return (
            <div className="space-y-4" data-testid="api-reference-loading">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-64 w-full" />
            </div>
        );
    }

    if (state.kind === "error") {
        return (
            <EmptyState
                description={t("Couldn't load the OpenAPI spec: {message}", { message: state.message })}
                testId="api-reference-error"
                title={t("API reference unavailable")}
            />
        );
    }

    if (state.kind === "empty") {
        return (
            <EmptyState
                description={t("Run `cirrus codegen` and wire `_generated/openapi.json` to the worker to render the API reference here.")}
                testId="api-reference-empty"
                title={t("No OpenAPI spec configured")}
            />
        );
    }

    return (
        <div className="min-h-0 flex-1 overflow-hidden" data-testid="api-reference">
            <ApiReferenceReact configuration={configuration as AnyApiReferenceConfiguration} />
        </div>
    );
};

export type { ApiReferencePanelProps };
export default ApiReferencePanel;
