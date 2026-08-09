/**
 * Language-agnostic half of SDK generation: turn an OpenRPC document
 * (`_generated/openrpc.json`, see {@link file://../openrpc.ts}) into the parsed
 * shape every per-language target renders from.
 *
 * Nothing here knows about a target language. A target supplies its own member
 * naming and templates (see {@link file://./targets}); everything that would
 * otherwise be re-derived per language — how a `functionPath` splits, which
 * runtime verb a kind maps to, whether a schema is real or the untyped
 * placeholder, how namespaces group and sort — lives here exactly once.
 *
 * That single-source rule is not stylistic. `paths.ts` documents the same
 * discipline for namespaces ("if these ever disagree, runtime dispatch silently
 * misses functions"), and the failure mode here is the same in a new costume: a
 * target that re-derives a model name renders an import pointing at a class
 * quicktype never emitted.
 */

/** One OpenRPC method as {@link file://../openrpc.ts} emits it. */
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

/** The runtime verbs a generated SDK can call. Mirrors the client transports. */
type RuntimeVerb = "action" | "mutation" | "query";

/** One RPC function, parsed and language-neutral. */
interface SdkMethod {
    /** Generated args model name, or `undefined` when the function takes none. */
    argsType: string | undefined;
    /** Raw exported function name (`"list"`), before any naming convention. */
    functionName: string;
    /** The wire identifier (`"messages:list"`), emitted verbatim into calls. */
    functionPath: string;
    /** Raw file namespace (`"messages"`), before any naming convention. */
    namespace: string;
    /** Generated result model name, or `undefined` while the result is untyped. */
    resultType: string | undefined;
    /** Human summary for the doc comment. */
    summary: string;
    /** Which runtime verb this dispatches to. */
    verb: RuntimeVerb;
}

/** One namespace's functions, sorted. */
interface SdkNamespace {
    methods: ReadonlyArray<SdkMethod>;
    /** Raw namespace (`"messages"`); a target applies its own casing. */
    name: string;
}

const NON_ALPHANUMERIC = /[^a-zA-Z0-9]+/gu;
const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/gu;

/** `messages_list` / `messages-list` → `MessagesList`. Type names are PascalCase in every target. */
const toPascalCase = (value: string): string =>
    value
        .split(NON_ALPHANUMERIC)
        .filter((part) => part.length > 0)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("");

/** `listMessages` → `list_messages`. */
const toSnakeCase = (value: string): string => value.replaceAll(CAMEL_BOUNDARY, "$1_$2").replaceAll(NON_ALPHANUMERIC, "_").toLowerCase();

/** `list_messages` → `listMessages`. */
const toCamelCase = (value: string): string => {
    const pascal = toPascalCase(value);

    return pascal.charAt(0).toLowerCase() + pascal.slice(1);
};

/**
 * True when a schema actually describes a shape.
 *
 * `openrpc.ts` emits a description-only placeholder for any function without a
 * declared `.output()` (the return type is TS-inferred and absent from the IR).
 * A placeholder must never become a generated model: quicktype would render an
 * empty type, and the surface would decode every response into it — silently
 * discarding the real payload rather than leaving it untyped.
 */
const isTypedSchema = (schema: Record<string, unknown> | undefined): boolean => {
    if (schema === undefined) {
        return false;
    }

    return ["$ref", "allOf", "anyOf", "enum", "items", "oneOf", "properties", "type"].some((key) => key in schema);
};

/**
 * The runtime verb a function kind maps to.
 *
 * `action` is deliberately NOT folded into `mutation`. Both post the same
 * envelope, but only `mutation` carries an idempotency key
 * (`x-lunora-mutation-id`); sharing the verb would advertise a de-duplication
 * the server does not perform for actions. An unknown kind is treated as a
 * write, which fails safe: at worst a read is sent over the write path.
 */
const verbForKind = (kind: string | undefined): RuntimeVerb => {
    if (kind === "query") {
        return "query";
    }

    return kind === "action" ? "action" : "mutation";
};

/** Parse one OpenRPC method. Model names are derived HERE and nowhere else. */
const parseMethod = (method: OpenRpcMethod): SdkMethod => {
    const [namespace = "", functionName = ""] = method.name.split(":");
    const base = `${toPascalCase(namespace)}${toPascalCase(functionName)}`;

    return {
        argsType: isTypedSchema(method.params?.[0]?.schema) ? `${base}Args` : undefined,
        functionName,
        functionPath: method.name,
        namespace,
        resultType: isTypedSchema(method.result?.schema) ? `${base}Result` : undefined,
        summary: method.summary ?? method.name,
        verb: verbForKind(method["x-lunora-function-kind"]),
    };
};

/**
 * Group a document's methods by namespace, sorted at both levels so a
 * regeneration against an unchanged schema is byte-identical.
 */
const parseSpec = (document: OpenRpcDocument): ReadonlyArray<SdkNamespace> => {
    const byNamespace = new Map<string, SdkMethod[]>();

    for (const method of document.methods) {
        const parsed = parseMethod(method);
        const existing = byNamespace.get(parsed.namespace);

        if (existing === undefined) {
            byNamespace.set(parsed.namespace, [parsed]);
        } else {
            existing.push(parsed);
        }
    }

    return [...byNamespace.entries()]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([name, methods]) => {
            return { methods: methods.toSorted((a, b) => a.functionName.localeCompare(b.functionName)), name };
        });
};

/**
 * The (name, schema) pairs the model renderer feeds to quicktype — derived from
 * {@link parseMethod}, so a model's name and the surface's reference to it can
 * never disagree.
 */
const modelSources = (document: OpenRpcDocument): ReadonlyArray<{ name: string; schema: Record<string, unknown> }> =>
    document.methods
        .flatMap((method) => {
            const parsed = parseMethod(method);

            return [
                { name: parsed.argsType, schema: method.params?.[0]?.schema },
                { name: parsed.resultType, schema: method.result?.schema },
            ];
        })
        .filter((source): source is { name: string; schema: Record<string, unknown> } => source.name !== undefined && source.schema !== undefined)
        .toSorted((a, b) => a.name.localeCompare(b.name));

/** Every method in the document, flattened — for imports and summary counts. */
const allMethods = (namespaces: ReadonlyArray<SdkNamespace>): ReadonlyArray<SdkMethod> => namespaces.flatMap((namespace) => namespace.methods);

/** The model names a surface actually references, de-duplicated and sorted. */
const referencedModels = (namespaces: ReadonlyArray<SdkNamespace>): ReadonlyArray<string> =>
    [
        ...new Set(
            allMethods(namespaces)
                .flatMap((method) => [method.argsType, method.resultType])
                .filter((name): name is string => name !== undefined),
        ),
    ].toSorted((a, b) => a.localeCompare(b));

export { allMethods, isTypedSchema, modelSources, parseMethod, parseSpec, referencedModels, toCamelCase, toPascalCase, toSnakeCase, verbForKind };
export type { OpenRpcDocument, OpenRpcMethod, RuntimeVerb, SdkMethod, SdkNamespace };
