import type { ReactElement } from "react";

import { useT } from "../i18n-context";
import MethodBadge from "./method-badge";
import type { ApiOperation } from "./openapi-model";
import { SchemaTable } from "./schema-view";
import TryIt from "./try-it";

interface OperationViewProps {
    readonly operation: ApiOperation;
}

/**
 * The centre column for one selected operation: a header (method/kind chip, the
 * endpoint, title, description), the live try-it console, the request-argument
 * schema table, and a row per documented response. Pure studio primitives — the
 * content scrolls within its column with no portals or overlays.
 */
const OperationView = ({ operation }: OperationViewProps): ReactElement => {
    const t = useT();

    return (
        <div className="flex flex-col gap-6" data-testid={`api-operation-${operation.operationId}`}>
            <header className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                    <MethodBadge kind={operation.kind} method={operation.method} testId="api-operation-method" />
                    <code className="font-mono text-xs text-muted-foreground">
                        {operation.method} {operation.functionPath ?? operation.httpPath}
                    </code>
                </div>
                <h1 className="text-lg font-semibold text-foreground" data-testid="api-operation-title">
                    {operation.title}
                </h1>
                {operation.description !== undefined && <p className="text-sm text-muted-foreground">{operation.description}</p>}
            </header>

            <section className="flex flex-col gap-2">
                <h2 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{t("Try it")}</h2>
                {/* Keyed on the operation so switching operations remounts the console with
                    a freshly-seeded args editor and a cleared result (no reset effect). */}
                <TryIt key={operation.key} operation={operation} />
            </section>

            <section className="flex flex-col gap-2">
                <h2 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{t("Request arguments")}</h2>
                <SchemaTable schema={operation.argsSchema} testId="api-operation-args" />
            </section>

            <section className="flex flex-col gap-3">
                <h2 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{t("Responses")}</h2>
                {operation.responses.map((response) => (
                    <div className="flex flex-col gap-1.5 rounded-md border border-border p-3" key={response.status}>
                        <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-semibold text-foreground">{response.status}</span>
                            {response.description !== undefined && <span className="text-xs text-muted-foreground">{response.description}</span>}
                        </div>
                        {response.schema !== undefined && <SchemaTable schema={response.schema} testId={`api-response-${response.status}`} />}
                    </div>
                ))}
            </section>
        </div>
    );
};

export default OperationView;
