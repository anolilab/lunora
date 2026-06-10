import { useCirrus } from "@cirrus/react";
import type { ReactElement } from "react";
import { useCallback, useMemo } from "react";

import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { EmptyState } from "./components/ui/empty-state";
import { Skeleton } from "./components/ui/skeleton";
import { useT } from "./i18n-context";
import { fireAndForget } from "./internal";
import type { SpecFetchState } from "./use-admin-spec";
import { useAdminSpec } from "./use-admin-spec";

interface OpenRpcReferencePanelProps {
    /**
     * Inline OpenRPC document. When supplied the panel renders it directly and
     * skips the fetch — used by the mock harness and by hosts that already hold
     * the generated spec. When omitted the panel fetches the worker's
     * admin-gated `GET /_cirrus/admin/openrpc` endpoint via the client.
     */
    readonly spec?: unknown;
}

/** A JSON-Schema-ish node as it appears in the OpenRPC params/result schemas. */
interface SchemaNode {
    anyOf?: SchemaNode[];
    const?: unknown;
    description?: string;
    items?: SchemaNode;
    properties?: Record<string, SchemaNode>;
    required?: string[];
    type?: string;
}

/** One OpenRPC method parameter. */
interface OpenRpcParameter {
    description?: string;
    name: string;
    required?: boolean;
    schema?: SchemaNode;
}

/** One OpenRPC method. */
interface OpenRpcMethod {
    description?: string;
    name: string;
    params?: OpenRpcParameter[];
    result?: { name?: string; schema?: SchemaNode };
    summary?: string;
    "x-cirrus-function-kind"?: string;
    "x-tags"?: { name: string }[];
}

/** The studio's view of an OpenRPC document — only the fields the panel reads. */
interface OpenRpcDocument {
    methods?: OpenRpcMethod[];
}

/** A document with no `methods` (or an empty array) is the worker's "not configured" sentinel. */
const isEmptyDocument = (document: OpenRpcDocument): boolean => document.methods === undefined || document.methods.length === 0;

/** Classify a resolved document into the `ready`/`empty` terminal states (see {@link useAdminSpec}). */
const classifyDocument = (spec: unknown): SpecFetchState<OpenRpcDocument> => {
    const document = spec as OpenRpcDocument;

    return isEmptyDocument(document) ? { kind: "empty" } : { kind: "ready", spec: document };
};

/** The method's `args` param (or its first param), shared by the example builder and the card. */
const argsParameterOf = (method: OpenRpcMethod): OpenRpcParameter | undefined => (method.params ?? []).find((parameter) => parameter.name === "args") ?? (method.params ?? [])[0];

/** Render a schema node as a short, human-readable type label (best-effort, non-recursive past one level). */
const typeLabel = (schema: SchemaNode | undefined): string => {
    if (schema === undefined) {
        return "any";
    }

    if (schema.const !== undefined) {
        return JSON.stringify(schema.const);
    }

    if (schema.anyOf !== undefined && schema.anyOf.length > 0) {
        return schema.anyOf.map((member) => typeLabel(member)).join(" | ");
    }

    if (schema.type === "array") {
        return `${typeLabel(schema.items)}[]`;
    }

    return schema.type ?? "any";
};

/** A minimal JSON value standing in for a schema, used to build the request example. */
const exampleForSchema = (schema: SchemaNode | undefined): unknown => {
    if (schema === undefined) {
        return null;
    }

    if (schema.const !== undefined) {
        return schema.const;
    }

    if (schema.anyOf !== undefined && schema.anyOf.length > 0) {
        return exampleForSchema(schema.anyOf[0]);
    }

    switch (schema.type) {
        case "array": {
            return [];
        }
        case "boolean": {
            return false;
        }
        case "number": {
            return 0;
        }
        case "object": {
            const out: Record<string, unknown> = {};

            for (const [key, child] of Object.entries(schema.properties ?? {})) {
                out[key] = exampleForSchema(child);
            }

            return out;
        }
        case "string": {
            return "";
        }
        default: {
            return null;
        }
    }
};

/**
 * Build the raw JSON-RPC request example for a method. Cirrus's transport posts
 * `{ functionPath, args }` to `/_cirrus/rpc`; the example shows the equivalent
 * JSON-RPC envelope an OpenRPC client would send, with the args object filled
 * from the method's single `args` param schema.
 */
const requestExample = (method: OpenRpcMethod): string => {
    const argsParameter = argsParameterOf(method);
    const params = argsParameter === undefined ? {} : { args: exampleForSchema(argsParameter.schema) };

    return JSON.stringify({ id: 1, jsonrpc: "2.0", method: method.name, params }, undefined, 2);
};

/** Copy `text` to the clipboard if the browser exposes one; a no-op under SSR/tests without it. */
const copyToClipboard = (text: string): void => {
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- browser-only clipboard; guarded by the "navigator" in globalThis check
    const clipboard: Clipboard | undefined = "navigator" in globalThis ? globalThis.navigator.clipboard : undefined;

    if (clipboard === undefined) {
        return;
    }

    fireAndForget(clipboard.writeText(text));
};

interface CodeBlockProps {
    readonly code: string;
    readonly label: string;
    readonly testId: string;
}

/** A labelled `pre` with a Copy button — mirrors the snippet view's block style. */
const CodeBlock = ({ code, label, testId }: CodeBlockProps): ReactElement => {
    const t = useT();

    const onCopy = useCallback((): void => {
        copyToClipboard(code);
    }, [code]);

    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">{label}</span>
                <Button data-testid={`${testId}-copy`} onClick={onCopy} size="xs" type="button" variant="ghost">
                    {t("Copy")}
                </Button>
            </div>
            <pre className="overflow-auto rounded-md border border-border bg-muted/50 p-3 font-mono text-xs" data-testid={testId}>
                {code}
            </pre>
        </div>
    );
};

interface SchemaTableProps {
    readonly schema: SchemaNode | undefined;
    readonly testId: string;
}

/**
 * Render an object schema's top-level properties as a name / type / required
 * table. A non-object schema renders a single type row. Used for both a method's
 * args param and its result.
 */
const SchemaTable = ({ schema, testId }: SchemaTableProps): ReactElement => {
    const t = useT();
    const required = useMemo(() => new Set(schema?.required), [schema]);
    const rows = useMemo(() => Object.entries(schema?.properties ?? {}), [schema]);

    if (schema?.type !== "object" || rows.length === 0) {
        return (
            <p className="font-mono text-xs text-muted-foreground" data-testid={testId}>
                {typeLabel(schema)}
            </p>
        );
    }

    return (
        <table className="w-full border-collapse text-xs" data-testid={testId}>
            <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-1 pr-3 font-medium">{t("Field")}</th>
                    <th className="py-1 pr-3 font-medium">{t("Type")}</th>
                    <th className="py-1 font-medium">{t("Required")}</th>
                </tr>
            </thead>
            <tbody>
                {rows.map(([name, child]) => (
                    <tr className="border-b border-border/50" key={name}>
                        <td className="py-1 pr-3 font-mono text-foreground">{name}</td>
                        <td className="py-1 pr-3 font-mono text-muted-foreground">{typeLabel(child)}</td>
                        <td className="py-1 text-muted-foreground">{required.has(name) ? t("yes") : t("no")}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
};

interface MethodCardProps {
    readonly method: OpenRpcMethod;
}

/** One method's detail card: description, params table, result type, and a JSON-RPC example. */
const MethodCard = ({ method }: MethodCardProps): ReactElement => {
    const t = useT();
    const example = useMemo(() => requestExample(method), [method]);
    const argsParameter = useMemo(() => argsParameterOf(method), [method]);

    return (
        <div className="flex flex-col gap-3 rounded-md border border-border p-4" data-testid={`openrpc-method-${method.name}`}>
            <div className="flex items-center gap-2">
                <h3 className="font-mono text-sm font-semibold text-foreground">{method.name}</h3>
                {method["x-cirrus-function-kind"] !== undefined && <Badge variant="outline">{method["x-cirrus-function-kind"]}</Badge>}
            </div>

            {method.description !== undefined && <p className="text-xs text-muted-foreground">{method.description}</p>}

            <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">{t("Params")}</span>
                <SchemaTable schema={argsParameter?.schema} testId={`openrpc-params-${method.name}`} />
            </div>

            <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">{t("Result")}</span>
                <SchemaTable schema={method.result?.schema} testId={`openrpc-result-${method.name}`} />
            </div>

            <CodeBlock code={example} label={t("JSON-RPC request")} testId={`openrpc-example-${method.name}`} />
        </div>
    );
};

interface MethodGroup {
    readonly methods: ReadonlyArray<OpenRpcMethod>;
    readonly namespace: string;
}

/** Group methods by their `x-tags` namespace (falling back to the `file:` prefix of `name`). */
const groupMethods = (methods: ReadonlyArray<OpenRpcMethod>): ReadonlyArray<MethodGroup> => {
    const byNamespace = new Map<string, OpenRpcMethod[]>();

    for (const method of methods) {
        const namespace = method["x-tags"]?.[0]?.name ?? (method.name.includes(":") ? method.name.slice(0, method.name.indexOf(":")) : "");
        const bucket = byNamespace.get(namespace) ?? [];

        bucket.push(method);
        byNamespace.set(namespace, bucket);
    }

    return [...byNamespace.entries()]
        .map(([namespace, group]) => {
            return { methods: group.toSorted((a, b) => a.name.localeCompare(b.name)), namespace };
        })
        .toSorted((a, b) => a.namespace.localeCompare(b.namespace));
};

/**
 * In-studio OpenRPC reference: a lightweight, custom viewer for the generated
 * OpenRPC 1.x document (the RPC-native spec). Methods are grouped by their
 * `file:` namespace; each renders a params/result table derived from the JSON
 * Schema plus a raw JSON-RPC request example. Built in-house rather than
 * embedding `@open-rpc/docs-react`, whose React-18 + full-MUI peer footprint
 * does not fit this React-19 Vite SPA cleanly.
 *
 * The spec comes from an inline {@link OpenRpcReferencePanelProps.spec} prop, or
 * — by default — the worker's admin-gated `GET /_cirrus/admin/openrpc` endpoint
 * fetched through the client.
 */
const OpenRpcReferencePanel = ({ spec: inlineSpec }: OpenRpcReferencePanelProps): ReactElement => {
    const t = useT();
    const client = useCirrus();

    const fetchOpenRpc = useCallback(() => client.fetchOpenRpc(), [client]);
    const state = useAdminSpec<OpenRpcDocument>(inlineSpec, fetchOpenRpc, classifyDocument);

    const groups = useMemo(() => (state.kind === "ready" ? groupMethods(state.spec.methods ?? []) : []), [state]);

    if (state.kind === "loading") {
        return (
            <div className="space-y-4" data-testid="openrpc-reference-loading">
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

    if (state.kind === "empty") {
        return (
            <EmptyState
                description={t(
                    "Run `cirrus codegen --api-spec openrpc` and wire `_generated/openrpc.json` to the worker to render the OpenRPC reference here.",
                )}
                testId="openrpc-reference-empty"
                title={t("No OpenRPC spec configured")}
            />
        );
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto" data-testid="openrpc-reference">
            {groups.map((group) => (
                <section className="flex flex-col gap-3" key={group.namespace}>
                    <h2 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{group.namespace || t("(root)")}</h2>
                    {group.methods.map((method) => (
                        <MethodCard key={method.name} method={method} />
                    ))}
                </section>
            ))}
        </div>
    );
};

export type { OpenRpcReferencePanelProps };
export default OpenRpcReferencePanel;
