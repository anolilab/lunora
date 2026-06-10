import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

import { Button } from "../components/ui/button";
import { useT } from "../i18n-context";
import { copyToClipboard } from "../internal";
import type { ApiOperation } from "./openapi-model";
import { exampleForSchema } from "./schema-view";

/** The languages the sample switcher offers. */
type Sample = "cirrus" | "curl" | "javascript";

const SAMPLE_ORDER: ReadonlyArray<Sample> = ["curl", "javascript", "cirrus"];
const SAMPLE_LABEL: Record<Sample, string> = { cirrus: "Cirrus", curl: "cURL", javascript: "JavaScript" };

/** Map an RPC `functionPath` (`file:export`) onto its generated typed handle, e.g. `api.messages.list`. */
const apiReferenceOf = (functionPath: string): string => `api.${functionPath.replaceAll(/[/:]/g, ".")}`;

/** The JSON request body the samples post — the RPC envelope for an RPC op, else the raw args. */
const requestBody = (operation: ApiOperation): unknown => {
    const args = exampleForSchema(operation.argsSchema) ?? {};

    return operation.functionPath === undefined ? args : { args, functionPath: operation.functionPath };
};

/** Build the sample source for a given language. */
const sampleSource = (sample: Sample, operation: ApiOperation, server: string): string => {
    const url = `${server}${operation.httpPath}`;
    const body = JSON.stringify(requestBody(operation), undefined, 2);
    const args = JSON.stringify(exampleForSchema(operation.argsSchema) ?? {}, undefined, 2);

    switch (sample) {
        case "cirrus": {
            if (operation.functionPath === undefined) {
                return `await fetch(${JSON.stringify(operation.httpPath)}, { method: ${JSON.stringify(operation.method)} });`;
            }

            const method = operation.kind ?? "query";

            // Emit the public, documented surface — the generated `api.*` handle —
            // not the internal `{ __cirrusRef }` admin escape hatch.
            return `import { useCirrus } from "@cirrus/react";\nimport { api } from "./_generated/api";\n\nconst client = useCirrus();\nawait client.${method}(${apiReferenceOf(operation.functionPath)}, ${args});`;
        }
        case "curl": {
            const hasBody = operation.method !== "GET" && operation.method !== "HEAD";
            const lines = [`curl -X ${operation.method} ${JSON.stringify(url)}`];

            if (hasBody) {
                lines.push(`  -H "Content-Type: application/json"`, `  -d '${body}'`);
            }

            return lines.join(" \\\n");
        }
        default: {
            const hasBody = operation.method !== "GET" && operation.method !== "HEAD";
            const init = hasBody
                ? `{\n  method: ${JSON.stringify(operation.method)},\n  headers: { "Content-Type": "application/json" },\n  body: JSON.stringify(${body}),\n}`
                : `{ method: ${JSON.stringify(operation.method)} }`;

            return `const response = await fetch(${JSON.stringify(url)}, ${init});\nconst data = await response.json();`;
        }
    }
};

interface CodeSamplesProps {
    readonly operation: ApiOperation;
    /** Server origin to prefix paths with in the samples (empty → same-origin). */
    readonly server: string;
}

/**
 * The right-rail request samples: a small language switcher (cURL / JavaScript /
 * Cirrus client) over the selected operation, each copy-paste ready. Mirrors the
 * code panel in Scalar's three-column layout, but rendered with the studio's own
 * primitives — no embedded Vue app.
 */
const CodeSamples = ({ operation, server }: CodeSamplesProps): ReactElement => {
    const t = useT();
    const [sample, setSample] = useState<Sample>("curl");

    const source = useMemo(() => sampleSource(sample, operation, server), [sample, operation, server]);

    const onCopy = useCallback((): void => {
        copyToClipboard(source);
    }, [source]);

    const onSelect = useCallback((event: React.MouseEvent<HTMLButtonElement>): void => {
        setSample(event.currentTarget.dataset.sample as Sample);
    }, []);

    return (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-sidebar/50" data-testid="api-code-samples">
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <div className="flex gap-1" role="tablist">
                    {SAMPLE_ORDER.map((key) => (
                        <button
                            aria-selected={sample === key}
                            className="rounded px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground aria-selected:bg-muted aria-selected:font-medium aria-selected:text-foreground"
                            data-sample={key}
                            data-testid={`api-sample-${key}`}
                            key={key}
                            onClick={onSelect}
                            role="tab"
                            type="button"
                        >
                            {SAMPLE_LABEL[key]}
                        </button>
                    ))}
                </div>
                <Button data-testid="api-sample-copy" onClick={onCopy} size="xs" type="button" variant="ghost">
                    {t("Copy")}
                </Button>
            </div>
            <pre className="overflow-auto px-3 pb-3 font-mono text-xs" data-testid="api-sample-source">
                {source}
            </pre>
        </div>
    );
};

export default CodeSamples;
