import type { SchemaNode } from "./schema-view";

/** HTTP methods an OpenAPI path item may carry. */
const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"] as const;

/** One media-typed body/response payload — the `application/json` schema is the one we render. */
interface MediaContent {
    content?: Record<string, { schema?: SchemaNode }>;
}

interface RawResponse extends MediaContent {
    $ref?: string;
    description?: string;
}

interface RawOperation {
    description?: string;
    operationId?: string;
    requestBody?: MediaContent & { required?: boolean };
    responses?: Record<string, RawResponse>;
    summary?: string;
    tags?: string[];
    "x-cirrus-function-kind"?: string;
}

interface RawDocument {
    components?: { responses?: Record<string, RawResponse>; schemas?: Record<string, SchemaNode> };
    info?: { description?: string; title?: string; version?: string };
    paths?: Record<string, Record<string, RawOperation>>;
    servers?: { description?: string; url: string }[];
    tags?: { description?: string; name: string }[];
}

/** One rendered response row (status + its JSON schema, with `$ref`s resolved). */
interface ApiResponse {
    description?: string;
    schema?: SchemaNode;
    status: string;
}

/** A single operation, flattened from a path item for direct rendering. */
interface ApiOperation {
    /** The request-body JSON schema — for a Cirrus RPC op this is the `args` sub-schema; otherwise the whole body. */
    argsSchema?: SchemaNode;
    description?: string;
    /** The `functionPath` const for a Cirrus RPC op (drives the try-it transport). */
    functionPath?: string;
    /** The HTTP path the operation is served at (the part before any `#` disambiguator). */
    httpPath: string;
    /** Stable identity (the raw path-item key, unique even when many ops share `/_cirrus/rpc`). */
    key: string;
    /** Cirrus function kind (`query` / `mutation` / `action`) when this is an RPC op. */
    kind?: string;
    method: string;
    operationId: string;
    /** The full request-body JSON schema (the RPC envelope for an RPC op), used for code samples. */
    requestSchema?: SchemaNode;
    responses: ApiResponse[];
    summary: string;
    tags: string[];
    title: string;
}

/** Operations grouped under a tag, in document tag order. */
interface ApiTagGroup {
    description?: string;
    name: string;
    operations: ApiOperation[];
}

/** The parsed, render-ready view of an OpenAPI document. */
interface ApiModel {
    groups: ApiTagGroup[];
    operationByKey: Map<string, ApiOperation>;
    server?: string;
    title: string;
    version?: string;
}

/** Pull the `application/json` schema out of a media container, if present. */
const jsonSchemaOf = (media: MediaContent | undefined): SchemaNode | undefined => media?.content?.["application/json"]?.schema;

/** Flatten an operation's responses into rendered rows, resolving any local `$ref`. */
const buildResponses = (operation: RawOperation, document: RawDocument): ApiResponse[] =>
    Object.entries(operation.responses ?? {}).map(([status, raw]) => {
        const name = raw.$ref?.replace("#/components/responses/", "");
        const resolved = name === undefined ? raw : (document.components?.responses?.[name] ?? raw);

        return { description: resolved.description, schema: jsonSchemaOf(resolved), status };
    });

/**
 * Flatten one raw operation into an {@link ApiOperation}. Cirrus's emitted RPC
 * schema is recognised — the meaningful `args` sub-schema and the `functionPath`
 * const are lifted out so the request table and the live try-it console show the
 * function arguments rather than the transport envelope.
 */
const flattenOperation = (pathKey: string, httpPath: string, method: string, operation: RawOperation, document: RawDocument): ApiOperation => {
    const requestSchema = jsonSchemaOf(operation.requestBody);
    const functionPathConst = requestSchema?.properties?.["functionPath"]?.const;
    const functionPath = typeof functionPathConst === "string" ? functionPathConst : undefined;
    // For an RPC op the user-facing arguments live under `args`; for a plain REST
    // body the whole request schema is the argument shape.
    const argsSchema = functionPath === undefined ? requestSchema : requestSchema?.properties?.["args"];
    const operationId = operation.operationId ?? `${method} ${httpPath}`;

    return {
        argsSchema,
        description: operation.description,
        functionPath,
        httpPath,
        key: pathKey,
        kind: operation["x-cirrus-function-kind"],
        method: method.toUpperCase(),
        operationId,
        requestSchema,
        responses: buildResponses(operation, document),
        summary: operation.summary ?? operationId,
        tags: operation.tags ?? [],
        title: operation.summary ?? operationId,
    };
};

/** Flatten every operation in the document, preserving discovery order. */
const collectOperations = (document: RawDocument): ApiOperation[] => {
    const operations: ApiOperation[] = [];

    for (const [pathKey, pathItem] of Object.entries(document.paths ?? {})) {
        const httpPath = pathKey.includes("#") ? pathKey.slice(0, pathKey.indexOf("#")) : pathKey;

        for (const method of HTTP_METHODS) {
            const operation = pathItem[method];

            if (operation !== undefined) {
                operations.push(flattenOperation(pathKey, httpPath, method, operation, document));
            }
        }
    }

    return operations;
};

/**
 * Parse a generated OpenAPI 3.1 document into the studio's render model: every
 * operation flattened and grouped by its first tag, in document tag order, with
 * untagged operations collected last.
 */
const parseOpenApi = (raw: unknown): ApiModel => {
    const document = (raw ?? {}) as RawDocument;
    const operations = collectOperations(document);

    const tagMeta = new Map((document.tags ?? []).map((tag) => [tag.name, tag.description]));
    const seenTags = new Set<string>();
    const groups: ApiTagGroup[] = [];

    const pushGroup = (name: string): void => {
        if (seenTags.has(name)) {
            return;
        }

        seenTags.add(name);

        const members = operations.filter((operation) => (operation.tags[0] ?? "") === name);

        if (members.length > 0) {
            groups.push({ description: tagMeta.get(name), name, operations: members });
        }
    };

    // Declared tags first (document order), then any tag not declared at the top
    // level (including the untagged "" bucket).
    for (const tag of document.tags ?? []) {
        pushGroup(tag.name);
    }

    for (const operation of operations) {
        pushGroup(operation.tags[0] ?? "");
    }

    return {
        groups,
        operationByKey: new Map(operations.map((operation) => [operation.key, operation])),
        server: document.servers?.[0]?.url,
        title: document.info?.title ?? "API reference",
        version: document.info?.version,
    };
};

export type { ApiModel, ApiOperation, ApiResponse, ApiTagGroup };
export { parseOpenApi };
