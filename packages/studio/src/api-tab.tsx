/* eslint-disable unicorn/prevent-abbreviations -- "API" is the domain term for the studio's API tab; the file/export names mirror it. */
import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

import ApiDocsPanel from "./api-docs-panel";
import ApiReferencePanel from "./api-reference-panel";
import { Button } from "./components/ui/button";
import { useT } from "./i18n-context";
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
}

/** The two sub-views the API tab toggles between. */
type ApiView = "reference" | "snippets";

const VIEW_KEYS: ReadonlyArray<ApiView> = ["reference", "snippets"];

/**
 * The studio's API tab. Hosts two complementary surfaces behind a segmented
 * toggle. The Reference view is Scalar's interactive OpenAPI reference over the
 * generated spec (operation browser, schema/param tables, "try it" console). The
 * Snippets view is the per-function React / Client / CLI copy-paste browser
 * (`api-docs-panel`), kept as the lightweight "how do I call this" DX.
 *
 * Reference is the default: it's the richer, spec-driven view, and it degrades
 * to a clear empty state when no spec is wired.
 */
const ApiTab = ({ functions, initialShardKey, openApiSpec }: ApiTabProps): ReactElement => {
    const t = useT();
    const [view, setView] = useState<ApiView>("reference");

    const viewLabel = useMemo<Record<ApiView, string>>(() => {
        return { reference: t("Reference"), snippets: t("Snippets") };
    }, [t]);

    const selectView = useCallback((event: React.MouseEvent<HTMLButtonElement>): void => {
        setView(event.currentTarget.dataset.view as ApiView);
    }, []);

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-4" data-testid="cirrus-api-tab">
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

            {view === "reference" ? <ApiReferencePanel spec={openApiSpec} /> : <ApiDocsPanel functions={functions} initialShardKey={initialShardKey} />}
        </div>
    );
};

export type { ApiTabProps };
export default ApiTab;
