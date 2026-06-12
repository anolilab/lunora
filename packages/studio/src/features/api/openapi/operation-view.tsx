import type { ReactElement } from "react";

import { useT } from "../../../i18n/i18n-context";
import MethodBadge from "./method-badge";
import type { ApiOperation } from "./openapi-model";
import { SchemaTable } from "./schema-view";
import { statusDotClass, statusToneClass } from "./status-tone";
import TryIt from "./try-it";

interface OperationViewProps {
    readonly operation: ApiOperation;
}

/**
 * The centre column for one selected operation: a sticky header (method/kind
 * chip, endpoint, title, description), the request console, the request-argument
 * schema table, and a colour-coded row per documented response. Pure studio
 * primitives — the content scrolls within its column, the header stays pinned,
 * and a subtle enter animation plays on each operation switch.
 */
const OperationView = ({ operation }: OperationViewProps): ReactElement => {
    const t = useT();

    return (
        <div
            className="flex flex-col gap-6 duration-200 animate-in fade-in-0 slide-in-from-bottom-1"
            data-testid={`api-operation-${operation.operationId}`}
            key={operation.key}
        >
            <header className="sticky top-0 z-10 -mx-6 -mt-6 flex flex-col gap-2 border-b border-border bg-background/85 px-6 pt-6 pb-3 backdrop-blur">
                <div className="flex items-center gap-2">
                    <MethodBadge kind={operation.kind} method={operation.method} testId="api-operation-method" />
                    <code className="truncate font-mono text-xs text-muted-foreground">{operation.functionPath ?? operation.httpPath}</code>
                </div>
                <h1 className="text-lg font-semibold text-foreground" data-testid="api-operation-title">
                    {operation.title}
                </h1>
                {operation.description !== undefined && <p className="text-sm text-muted-foreground">{operation.description}</p>}
            </header>

            <section className="flex flex-col gap-2">
                <h2 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{t("Try it")}</h2>
                <TryIt />
            </section>

            <section className="flex flex-col gap-2">
                <h2 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{t("Request arguments")}</h2>
                <SchemaTable schema={operation.argsSchema} testId="api-operation-args" />
            </section>

            <section className="flex flex-col gap-3">
                <h2 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{t("Response body")}</h2>
                {operation.responses.map((response) => (
                    <div className="flex flex-col gap-1.5 rounded-md border border-border p-3" key={response.status}>
                        <div className="flex items-center justify-between gap-2">
                            <span className={`inline-flex items-center gap-1.5 font-mono text-xs font-semibold ${statusToneClass(response.status)}`}>
                                <span className={`size-1.5 rounded-full ${statusDotClass(response.status)}`} />
                                {response.status}
                            </span>
                            {response.schema !== undefined && (
                                <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                                    {t("application/json")}
                                </span>
                            )}
                        </div>
                        {response.description !== undefined && <p className="text-xs text-muted-foreground">{response.description}</p>}
                        {response.schema !== undefined && <SchemaTable schema={response.schema} testId={`api-response-${response.status}`} />}
                    </div>
                ))}
            </section>
        </div>
    );
};

export default OperationView;
