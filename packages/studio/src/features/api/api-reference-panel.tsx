import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";

import { EmptyState } from "../../components/ui/empty-state";
import { Skeleton } from "../../components/ui/skeleton";
import type { SpecFetchState } from "../../hooks/use-admin-spec";
import { useAdminSpec } from "../../hooks/use-admin-spec";
import { useT } from "../../i18n/i18n-context";
import { parseOpenApi } from "./openapi/openapi-model";
import ReferenceView from "./openapi/reference-view";

interface ApiReferencePanelProps {
    /**
     * Inline OpenAPI document. When supplied the panel renders it directly and
     * skips the fetch — used by the mock harness and by hosts that already hold
     * the generated spec. When omitted the panel fetches the worker's
     * admin-gated `GET /_lunora/admin/openapi` endpoint via the client.
     */
    readonly spec?: unknown;
}

/** The OpenAPI document shape the panel inspects to classify it (only `paths`). */
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
 * In-studio OpenAPI reference: renders the generated OpenAPI 3.1 document with
 * the studio-native {@link ReferenceView} — a tag-grouped operation browser,
 * schema tables, a live "try it" console, and copy-paste request samples, all
 * themed to the studio. The spec comes from an inline
 * {@link ApiReferencePanelProps.spec} prop, or — by default — the worker's
 * admin-gated `GET /_lunora/admin/openapi` endpoint fetched through the client.
 *
 * This replaced the embedded Scalar reference (a Vue app in React): Scalar's
 * portal/overlay layers repeatedly intercepted clicks and froze the tab, and it
 * shipped a multi-megabyte bundle. The native view is overlay-free and reuses
 * the studio's own primitives.
 */
const ApiReferencePanel = ({ spec: inlineSpec }: ApiReferencePanelProps): ReactElement => {
    const t = useT();
    const client = useLunora();

    const fetchOpenApi = () => client.fetchOpenApi();
    const state = useAdminSpec<OpenApiDocument>(inlineSpec, fetchOpenApi, classifySpec);

    const model = state.kind === "ready" ? parseOpenApi(state.spec) : undefined;

    if (state.kind === "loading") {
        return (
            <div className="flex flex-col gap-4" data-testid="api-reference-loading">
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

    if (state.kind === "empty" || model === undefined) {
        return (
            <EmptyState
                description={t("Run `lunora codegen` and wire `_generated/openapi.json` to the worker to render the API reference here.")}
                testId="api-reference-empty"
                title={t("No OpenAPI spec configured")}
            />
        );
    }

    return <ReferenceView model={model} />;
};

export type { ApiReferencePanelProps };
export default ApiReferencePanel;
