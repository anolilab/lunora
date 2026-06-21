import { useLunora } from "@lunora/react";
import type { ReactElement } from "react";

import { EmptyState } from "../../components/ui/empty-state";
import { Skeleton } from "../../components/ui/skeleton";
import type { SpecFetchState } from "../../hooks/use-admin-spec";
import { useAdminSpec } from "../../hooks/use-admin-spec";
import { useT } from "../../i18n/i18n-context";
import parseOpenRpc from "./openapi/openrpc-model";
import ReferenceView from "./openapi/reference-view";

interface OpenRpcReferencePanelProps {
    /**
     * Inline OpenRPC document. When supplied the panel renders it directly and
     * skips the fetch — used by the mock harness and by hosts that already hold
     * the generated spec. When omitted the panel fetches the worker's
     * admin-gated `GET /_lunora/admin/openrpc` endpoint via the client.
     */
    readonly spec?: unknown;
}

/** The OpenRPC document shape the panel inspects to classify it (only `methods`). */
type OpenRpcDocument = { methods?: unknown[] };

/** A document with no `methods` (or an empty array) is the worker's "not configured" sentinel. */
const isEmptyDocument = (document: OpenRpcDocument): boolean => document.methods === undefined || document.methods.length === 0;

/** Classify a resolved document into the `ready`/`empty` terminal states (see {@link useAdminSpec}). */
const classifyDocument = (spec: unknown): SpecFetchState<OpenRpcDocument> => {
    const document = spec as OpenRpcDocument;

    return isEmptyDocument(document) ? { kind: "empty" } : { kind: "ready", spec: document };
};

/**
 * In-studio OpenRPC reference. OpenRPC is the RPC-native spec (a `methods` array
 * over the JSON-RPC-shaped `POST /_lunora/rpc` transport), documenting the RPC
 * functions only. It is parsed into the shared `ApiModel` and rendered by the
 * same studio-native {@link ReferenceView} the OpenAPI panel uses, so both
 * formats share one operation browser, schema view, try-it console, and sample
 * rail.
 *
 * The spec comes from an inline {@link OpenRpcReferencePanelProps.spec} prop, or
 * — by default — the worker's admin-gated `GET /_lunora/admin/openrpc` endpoint.
 */
const OpenRpcReferencePanel = ({ spec: inlineSpec }: OpenRpcReferencePanelProps): ReactElement => {
    const t = useT();
    const client = useLunora();

    const fetchOpenRpc = () => client.fetchOpenRpc();
    const state = useAdminSpec<OpenRpcDocument>(inlineSpec, fetchOpenRpc, classifyDocument);

    const model = state.kind === "ready" ? parseOpenRpc(state.spec) : undefined;

    if (state.kind === "loading") {
        return (
            <div className="flex flex-col gap-4" data-testid="openrpc-reference-loading">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-64 w-full" />
            </div>
        );
    }

    if (state.kind === "error") {
        return (
            <EmptyState
                description={t("Couldn't load the OpenRPC spec: {message}", { message: state.message })}
                testId="openrpc-reference-error"
                title={t("API reference unavailable")}
            />
        );
    }

    if (state.kind === "empty" || model === undefined) {
        return (
            <EmptyState
                description={t(
                    "Run `lunora codegen --api-spec openrpc` and wire `_generated/openrpc.json` to the worker to render the OpenRPC reference here.",
                )}
                testId="openrpc-reference-empty"
                title={t("No OpenRPC spec configured")}
            />
        );
    }

    return <ReferenceView model={model} />;
};

export type { OpenRpcReferencePanelProps };
export default OpenRpcReferencePanel;
