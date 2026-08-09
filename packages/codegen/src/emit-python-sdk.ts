/**
 * Python SDK emitter: turns an OpenRPC document (`_generated/openrpc.json`, see
 * {@link file://./openrpc.ts}) into a typed Python client surface.
 *
 * ## The split
 *
 * Three layers; only the middle one is generated here.
 *
 * **Models** — `quicktype-core` renders the per-method args (and result, when a
 * schema exists) into dataclasses with `from_dict`/`to_dict`. Not our code:
 * quicktype handles the camelCase↔snake_case mapping, enums, optionals, and
 * nested records, in 19 languages.
 *
 * **Method surface** (this file) — one Python method per RPC function,
 * dispatching on `functionPath` through the runtime. A flat list, because
 * Lunora's RPC is one endpoint with a `functionPath` discriminator rather than a
 * route tree.
 *
 * **Transport** — the hand-written per-language runtime (`sdks/python/lunora`).
 * NOT generated and NOT vendored into the user's project: the generated code
 * imports it, so a wire-protocol fix is a runtime version bump rather than a
 * regenerate-everyone event.
 *
 * Emitting text (rather than driving a Python AST) is deliberate: the surface is
 * a flat `for` loop over methods, so a template is the whole job.
 */

import { FetchingJSONSchemaStore, InputData, JSONSchemaInput, quicktype } from "quicktype-core";

/** One OpenRPC method as {@link file://./openrpc.ts} emits it. */
interface OpenRpcMethod {
    name: string;
    params?: ReadonlyArray<{ name: string; schema?: Record<string, unknown> }>;
    result?: { name: string; schema?: Record<string, unknown> };
    summary?: string;
    "x-lunora-function-kind"?: string;
}

/** The `_generated/openrpc.json` document. */
interface OpenRpcDocument {
    info?: { title?: string; version?: string };
    methods: ReadonlyArray<OpenRpcMethod>;
}

/** Python reserved words a `functionPath`'s function half could collide with. */
const PYTHON_KEYWORDS = new Set([
    "and",
    "as",
    "assert",
    "async",
    "await",
    "break",
    "class",
    "continue",
    "def",
    "del",
    "elif",
    "else",
    "except",
    "False",
    "finally",
    "for",
    "from",
    "global",
    "if",
    "import",
    "in",
    "is",
    "lambda",
    "None",
    "nonlocal",
    "not",
    "or",
    "pass",
    "raise",
    "return",
    "True",
    "try",
    "while",
    "with",
    "yield",
]);

const NON_ALPHANUMERIC = /[^a-zA-Z0-9]+/gu;
const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/gu;

/** `messages_list` → `MessagesList`. */
const toPascalCase = (value: string): string =>
    value
        .split(NON_ALPHANUMERIC)
        .filter((part) => part.length > 0)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("");

/** `listMessages` → `list_messages`; a trailing `_` escapes a Python keyword. */
const toSnakeCase = (value: string): string => {
    const snake = value.replaceAll(CAMEL_BOUNDARY, "$1_$2").replaceAll(NON_ALPHANUMERIC, "_").toLowerCase();

    return PYTHON_KEYWORDS.has(snake) ? `${snake}_` : snake;
};

/**
 * A method's `name` is the wire `functionPath` — `"<namespace>:<function>"`,
 * the identifier the RPC envelope dispatches on. Split it once, here, so the
 * emitter never re-parses it.
 */
interface ParsedMethod {
    /** Generated args dataclass name, or `undefined` when the function takes none. */
    argsType: string | undefined;
    /** The wire identifier, emitted verbatim into the call. */
    functionPath: string;
    /** `query` | `mutation` | `action` — decides which runtime call is emitted. */
    kind: string;
    /** Python method name (`list`, `send_message`). */
    methodName: string;
    /** Namespace as a Python attribute (`messages`). */
    moduleName: string;
    /** Generated result dataclass name, or `undefined` when the schema is the untyped placeholder. */
    resultType: string | undefined;
    summary: string;
}

/**
 * True when a `result.schema` actually describes a shape. `openrpc.ts` emits a
 * description-only placeholder for every function without a declared
 * `.output()` (the return type is TS-inferred and not carried in the IR), and a
 * placeholder must not become a generated model — it would render as an empty
 * dataclass that silently discards the real response.
 */
const isTypedSchema = (schema: Record<string, unknown> | undefined): boolean => {
    if (schema === undefined) {
        return false;
    }

    return ["$ref", "allOf", "anyOf", "enum", "items", "oneOf", "properties", "type"].some((key) => key in schema);
};

/** Parse one OpenRPC method into everything the templates below need. */
const parseMethod = (method: OpenRpcMethod): ParsedMethod => {
    const [namespace = "", functionName = ""] = method.name.split(":");
    const base = `${toPascalCase(namespace)}${toPascalCase(functionName)}`;
    const argsSchema = method.params?.[0]?.schema;

    return {
        argsType: isTypedSchema(argsSchema) ? `${base}Args` : undefined,
        functionPath: method.name,
        kind: method["x-lunora-function-kind"] ?? "query",
        methodName: toSnakeCase(functionName),
        moduleName: toSnakeCase(namespace),
        resultType: isTypedSchema(method.result?.schema) ? `${base}Result` : undefined,
        summary: method.summary ?? method.name,
    };
};

/**
 * The runtime call a function kind maps to — one per kind, matching
 * `LunoraClient`. `action` is deliberately NOT folded into `mutation`: both post
 * the same envelope, but `mutation` accepts an idempotency key (`x-lunora-mutation-id`)
 * and an action must not, so collapsing them would offer a de-duplication
 * guarantee the server does not make for actions.
 */
const runtimeCall = (kind: string): string => {
    if (kind === "query") {
        return "query";
    }

    return kind === "action" ? "action" : "mutation";
};

/** Render one function as an `async def` that posts the RPC envelope. */
const renderCallMethod = (method: ParsedMethod): string => {
    const returns = method.resultType ?? "Any";
    const parameters = method.argsType === undefined ? "self" : `self, args: ${method.argsType}`;
    const payload = method.argsType === undefined ? "{}" : "args.to_dict()";
    // A typed result routes the decoded payload through quicktype's validating
    // `from_dict`; an untyped one is handed back as-is.
    const call = `await self._client.${runtimeCall(method.kind)}("${method.functionPath}", ${payload}, shard_key)`;
    const returnStatement = method.resultType === undefined ? `return ${call}` : `return ${method.resultType}.from_dict(${call})`;

    return [
        `    async def ${method.methodName}(${parameters}, *, shard_key: Optional[str] = None) -> ${returns}:`,
        `        """${method.summary}"""`,
        `        ${returnStatement}`,
    ].join("\n");
};

/**
 * Render a query's live-subscription method.
 *
 * Only `query` functions get one: the WS `subscribe` frame carries a
 * `query.functionPath`, and the server re-runs that query on every write to the
 * tables it touched. A mutation or action has nothing to re-run, so emitting a
 * `subscribe_*` for one would generate a call the server rejects.
 *
 * The transport stays hand-written (the socket, resume cursors, and poke
 * buffering live in the runtime) — only this typed entry point is generated.
 */
const renderSubscribeMethod = (method: ParsedMethod): string => {
    const payload = method.argsType === undefined ? "{}" : "args.to_dict()";

    const parameters = [
        "self",
        ...(method.argsType === undefined ? [] : [`args: ${method.argsType}`]),
        "on_data: Callback",
        "on_error: Optional[ErrorCallback] = None",
        "*",
        "shard_key: Optional[str] = None",
    ];

    return [
        `    def subscribe_${method.methodName}(`,
        ...parameters.map((parameter) => `        ${parameter},`),
        `    ) -> Unsubscribe:`,
        `        """live ${method.summary} — re-runs on every write to the tables it reads."""`,
        `        return self._client.subscribe("${method.functionPath}", ${payload}, on_data, on_error, shard_key)`,
    ].join("\n");
};

/** Render one namespace's class: a method per function, plus its `_client` handle. */
const renderNamespaceClass = (moduleName: string, methods: ReadonlyArray<ParsedMethod>): string => {
    const className = `${toPascalCase(moduleName)}Api`;

    const body = methods
        .map((method) => {
            const call = renderCallMethod(method);

            return method.kind === "query" ? `${call}\n\n${renderSubscribeMethod(method)}` : call;
        })
        .join("\n\n");

    return [
        `class ${className}:`,
        `    """Functions declared in \`${moduleName}\`."""`,
        ``,
        `    def __init__(self, client: LunoraClient) -> None:`,
        `        self._client = client`,
        ``,
        body,
    ].join("\n");
};

/** Inputs the Python SDK emitter needs. */
interface PythonSdkEmitInput {
    /** The parsed `_generated/openrpc.json`. */
    document: OpenRpcDocument;
    /** Rendered model source from quicktype (written alongside as `models.py`). */
    models: string;
}

/** The files a generation run writes, keyed by path relative to the output dir. */
type PythonSdkFiles = Record<string, string>;

const GENERATED_HEADER = `"""GENERATED by \`lunora sdk generate --lang python\` — do not edit.\n\nRun the command again to regenerate.\n"""\n\n`;

/**
 * Emit the Python SDK: `models.py` (quicktype's dataclasses), `api.py` (the
 * generated method surface), and `__init__.py` (the package re-export).
 *
 * Methods are grouped by namespace into one class each, hung off a root `Api`
 * object, so a caller writes `api.messages.list(args)`. Namespaces and methods
 * are sorted so a regeneration with an unchanged schema is byte-identical.
 */
const emitPythonSdk = (input: PythonSdkEmitInput): PythonSdkFiles => {
    const methods = input.document.methods.map((method) => parseMethod(method));

    const byNamespace = new Map<string, ParsedMethod[]>();

    for (const method of methods) {
        const existing = byNamespace.get(method.moduleName);

        if (existing === undefined) {
            byNamespace.set(method.moduleName, [method]);
        } else {
            existing.push(method);
        }
    }

    const namespaces = [...byNamespace.keys()].toSorted((a, b) => a.localeCompare(b));

    for (const namespace of namespaces) {
        byNamespace.get(namespace)?.sort((a, b) => a.methodName.localeCompare(b.methodName));
    }

    // Only the model names actually referenced by the surface are imported, so
    // an unused-import lint stays quiet on the generated file.
    const referenced = methods
        .flatMap((method) => [method.argsType, method.resultType])
        .filter((name): name is string => name !== undefined)
        .toSorted((a, b) => a.localeCompare(b));

    const modelImport = referenced.length > 0 ? `from .models import ${[...new Set(referenced)].join(", ")}\n` : "";

    const classes = namespaces.map((namespace) => renderNamespaceClass(namespace, byNamespace.get(namespace) ?? [])).join("\n\n\n");

    const rootAttributes = namespaces.map((namespace) => `        self.${namespace} = ${toPascalCase(namespace)}Api(client)`).join("\n");

    // The subscription callback/handle aliases are only imported when at least
    // one query produced a `subscribe_*`, so an action-only SDK stays clean.
    const hasSubscriptions = methods.some((method) => method.kind === "query");
    const runtimeImports = hasSubscriptions ? "Callback, ErrorCallback, LunoraClient, Unsubscribe" : "LunoraClient";

    const api = [
        GENERATED_HEADER,
        `from typing import Any, Optional\n`,
        `\n`,
        `from lunora.client import ${runtimeImports}\n`,
        modelImport,
        `\n\n`,
        classes,
        `\n\n\n`,
        `class Api:\n`,
        `    """Typed entry point: \`Api(client).<namespace>.<function>(args)\`."""\n`,
        `\n`,
        `    def __init__(self, client: LunoraClient) -> None:\n`,
        rootAttributes.length > 0 ? `${rootAttributes}\n` : `        pass\n`,
    ].join("");

    const exported = ["Api", ...namespaces.map((namespace) => `${toPascalCase(namespace)}Api`)];

    const initFile = [
        GENERATED_HEADER,
        `from .api import ${exported.join(", ")}\n`,
        `\n`,
        `__all__ = [${exported.map((name) => `"${name}"`).join(", ")}]\n`,
    ].join("");

    return {
        "__init__.py": initFile,
        "api.py": api,
        "models.py": input.models,
    };
};

/**
 * Render the model layer with quicktype: one dataclass per typed args/result
 * schema, named exactly as {@link parseMethod} expects.
 *
 * Both the model names and the surface's references come from `parseMethod`, so
 * they cannot drift — the same discipline `sanitizeNamespace` documents for the
 * three places that must agree on a namespace. Deriving the names twice is how
 * a generated import silently points at a class that was never rendered.
 */
const renderPythonModels = async (document: OpenRpcDocument): Promise<string> => {
    const schemaInput = new JSONSchemaInput(new FetchingJSONSchemaStore());

    // Sorted so a regeneration with an unchanged schema is byte-identical
    // (quicktype renders in source-add order).
    const sources = document.methods
        .flatMap((method) => {
            const parsed = parseMethod(method);

            return [
                { name: parsed.argsType, schema: method.params?.[0]?.schema },
                { name: parsed.resultType, schema: method.result?.schema },
            ];
        })
        .filter((source): source is { name: string; schema: Record<string, unknown> } => source.name !== undefined && source.schema !== undefined)
        .toSorted((a, b) => a.name.localeCompare(b.name));

    if (sources.length === 0) {
        return `${GENERATED_HEADER}# No typed argument or result schemas in this deployment.\n`;
    }

    for (const source of sources) {
        // eslint-disable-next-line no-await-in-loop -- addSource mutates shared input state; concurrent adds interleave type names.
        await schemaInput.addSource({ name: source.name, schema: JSON.stringify(source.schema) });
    }

    const inputData = new InputData();

    inputData.addInput(schemaInput);

    const { lines } = await quicktype({ inputData, lang: "python", rendererOptions: { "python-version": "3.7" } });

    return `${GENERATED_HEADER}${lines.join("\n")}\n`;
};

export { emitPythonSdk, isTypedSchema, renderPythonModels, toPascalCase, toSnakeCase };
export type { OpenRpcDocument, OpenRpcMethod, PythonSdkEmitInput, PythonSdkFiles };
