/* eslint-disable unicorn/prevent-abbreviations -- "API" is the domain term for the studio's API tab; the file/export names mirror it. */
import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

import ApiDocsPanel from "./api-docs-panel";
import ApiReferencePanel from "./api-reference-panel";
import { Button } from "./components/ui/button";
import { useT } from "./i18n-context";
import OpenRpcReferencePanel from "./openrpc-reference-panel";
import type { FunctionDescriptor } from "./types";

interface ApiTabProps {
    /** Registered functions documented by the snippets sub-view. Threaded host → studio. */
    readonly functions?: FunctionDescriptor[];

    /** Shard key the snippets view reads its table list from. */
    readonly initialShardKey?: string;

    /**
     * Inline OpenAPI document for the reference sub-view. When omitted the
     * reference fetches the worker's `GET /_cirrus/admin/openapi` endpoint.
     */
    readonly openApiSpec?: unknown;

    /**
     * Inline OpenRPC document for the reference sub-view's OpenRPC format. When
     * omitted the OpenRPC view fetches the worker's `GET /_cirrus/admin/openrpc`
     * endpoint. OpenRPC is the RPC-native spec (RPC functions only); OpenAPI
     * additionally covers `httpRouter()` REST routes.
     */
    readonly openRpcSpec?: unknown;
}

/** The two sub-views the API tab toggles between. */
type ApiView = "reference" | "snippets";

/** Which spec format the Reference sub-view renders. */
type ApiFormat = "openapi" | "openrpc";

const VIEW_KEYS: ReadonlyArray<ApiView> = ["reference", "snippets"];
const FORMAT_KEYS: ReadonlyArray<ApiFormat> = ["openapi", "openrpc"];

/**
 * The studio's API tab. Hosts two complementary surfaces behind a segmented
 * toggle. The Reference view renders a machine-readable spec — OpenAPI 3.1 via
 * Scalar's interactive reference (operation browser, "try it" console) or the
 * RPC-native OpenRPC document via the custom OpenRPC viewer — with a small
 * format switch between them. The Snippets view is the per-function React /
 * Client / CLI copy-paste browser (`api-docs-panel`), the lightweight "how do I
 * call this" DX.
 *
 * Reference is the default; OpenAPI is the default format (the richer,
 * spec-driven view that also covers REST). Each format degrades to a clear
 * empty state when its spec isn't wired.
 */
const ApiTab = ({ functions, initialShardKey, openApiSpec, openRpcSpec }: ApiTabProps): ReactElement => {
    const t = useT();
    const [view, setView] = useState<ApiView>("reference");
    const [format, setFormat] = useState<ApiFormat>("openapi");

    const viewLabel = useMemo<Record<ApiView, string>>(() => {
        return { reference: t("Reference"), snippets: t("Snippets") };
    }, [t]);

    const formatLabel = useMemo<Record<ApiFormat, string>>(() => {
        return { openapi: t("OpenAPI"), openrpc: t("OpenRPC") };
    }, [t]);

    const selectView = useCallback((event: React.MouseEvent<HTMLButtonElement>): void => {
        setView(event.currentTarget.dataset.view as ApiView);
    }, []);

    const selectFormat = useCallback((event: React.MouseEvent<HTMLButtonElement>): void => {
        setFormat(event.currentTarget.dataset.format as ApiFormat);
    }, []);

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-4" data-testid="cirrus-api-tab">
            <div className="flex flex-wrap items-center gap-3">
                <div aria-label={t("API view")} className="flex gap-1.5" data-testid="api-view-toggle" role="tablist">
                    {VIEW_KEYS.map((key) => (
                        <Button
                            aria-selected={view === key}
                            data-testid={`api-view-${key}`}
                            data-view={key}
                            key={key}
                            onClick={selectView}
                            role="tab"
                            size="sm"
                            type="button"
                            variant={view === key ? "default" : "outline"}
                        >
                            {viewLabel[key]}
                        </Button>
                    ))}
                </div>

                {view === "reference" && (
                    <div aria-label={t("API spec format")} className="flex gap-1.5" data-testid="api-format-toggle" role="tablist">
                        {FORMAT_KEYS.map((key) => (
                            <Button
                                aria-selected={format === key}
                                data-format={key}
                                data-testid={`api-format-${key}`}
                                key={key}
                                onClick={selectFormat}
                                role="tab"
                                size="sm"
                                type="button"
                                variant={format === key ? "default" : "outline"}
                            >
                                {formatLabel[key]}
                            </Button>
                        ))}
                    </div>
                )}
            </div>

            {view === "snippets" && <ApiDocsPanel functions={functions} initialShardKey={initialShardKey} />}
            {view === "reference" && format === "openapi" && <ApiReferencePanel spec={openApiSpec} />}
            {view === "reference" && format === "openrpc" && <OpenRpcReferencePanel spec={openRpcSpec} />}
        </div>
    );
};

export type { ApiTabProps };
export default ApiTab;
