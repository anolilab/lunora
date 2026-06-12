import type { ApiModel, ApiOperation, ApiTagGroup } from "./openapi-model";
import type { SchemaNode } from "./schema-view";

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

interface OpenRpcDocument {
    info?: { title?: string; version?: string };
    methods?: OpenRpcMethod[];
}

/** The method's `args` param (or its first param) — the user-facing argument schema. */
const argsParameterOf = (method: OpenRpcMethod): OpenRpcParameter | undefined =>
    (method.params ?? []).find((parameter) => parameter.name === "args") ?? (method.params ?? [])[0];

/** A method's namespace: its first `x-tags` entry, else the `file:` prefix of its name, else root. */
const namespaceOf = (method: OpenRpcMethod): string =>
    method["x-tags"]?.[0]?.name ?? (method.name.includes(":") ? method.name.slice(0, method.name.indexOf(":")) : "");

/** Flatten one OpenRPC method into the shared {@link ApiOperation} shape. */
const toOperation = (method: OpenRpcMethod): ApiOperation => {
    const argsSchema = argsParameterOf(method)?.schema;

    return {
        argsSchema,
        description: method.description,
        functionPath: method.name,
        httpPath: "/_cirrus/rpc",
        key: method.name,
        kind: method["x-cirrus-function-kind"],
        method: "POST",
        operationId: method.name,
        requestSchema: argsSchema,
        responses: [{ description: method.result?.name, schema: method.result?.schema, status: "200" }],
        summary: method.summary ?? method.name,
        tags: [namespaceOf(method)],
        title: method.summary ?? method.name,
    };
};

/**
 * Parse a generated OpenRPC 1.x document into the same {@link ApiModel} the
 * OpenAPI parser produces, so the shared {@link import("./reference-view").default}
 * renders both. Methods are grouped by their `file:` namespace; each method's
 * `args` param becomes the request schema and its `result` the sole (200)
 * response.
 */
const parseOpenRpc = (raw: unknown): ApiModel => {
    const document = (raw ?? {}) as OpenRpcDocument;
    const operations = (document.methods ?? []).map((method) => toOperation(method));

    const byNamespace = new Map<string, ApiOperation[]>();

    for (const operation of operations) {
        const namespace = operation.tags[0] ?? "";
        const bucket = byNamespace.get(namespace) ?? [];

        bucket.push(operation);
        byNamespace.set(namespace, bucket);
    }

    const groups: ApiTagGroup[] = [...byNamespace.entries()]
        .map(([name, members]): ApiTagGroup => {
            return { name, operations: members.toSorted((a, b) => a.operationId.localeCompare(b.operationId)) };
        })
        .toSorted((a, b) => a.name.localeCompare(b.name));

    return {
        groups,
        operationByKey: new Map(operations.map((operation) => [operation.key, operation])),
        title: document.info?.title ?? "API reference",
        version: document.info?.version,
    };
};

export default parseOpenRpc;
