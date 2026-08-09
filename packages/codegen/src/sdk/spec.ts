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
 *
 * Deriving names in one place is necessary but NOT sufficient, because only
 * half the decision is ours: quicktype chooses whether a predicted name becomes
 * a declared type, and different backends answer differently for the same
 * schema. {@link withDeclaredModels} reconciles the two halves before a target
 * renders anything.
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

/**
 * True when a schema contains a value the generated models cannot carry.
 *
 * `v.bigint()` schemas as `{format:"int64",type:"integer"}` and `v.bytes()` as
 * `{contentEncoding:"base64",type:"string"}`, because JSON Schema has no better
 * carrier. quicktype faithfully renders those as a plain integer and a plain
 * string — but the wire needs the TAGGED forms, `[TAG,"bigint","…"]` and
 * `[TAG,"bytes","…"]`, which no generated field can produce. A model built from
 * such a schema sends a number where the server's validator demands a bigint,
 * and every call fails validation.
 *
 * `v.date()` is deliberately NOT in this set: it schemas as an integer and is
 * genuinely epoch-milliseconds on the wire, so the plain rendering is correct.
 *
 * Walks nested properties and items, and the `allOf`/`anyOf`/`oneOf` branches.
 * `.nullable()` renders as `{ anyOf: [inner, { type: "null" }] }` and `v.union()`
 * the same way, so a branch is where a bigint or bytes leaf most often hides —
 * skipping them missed the single most common spelling and emitted a typed
 * model whose every call failed the server's validator, with no warning.
 */
const hasUnrepresentableWireType = (schema: unknown, depth = 0): boolean => {
    if (depth > 32 || schema === null || typeof schema !== "object") {
        return false;
    }

    if (Array.isArray(schema)) {
        return schema.some((entry) => hasUnrepresentableWireType(entry, depth + 1));
    }

    const node = schema as Record<string, unknown>;

    if (node["type"] === "integer" && node["format"] === "int64") {
        return true;
    }

    if (node["type"] === "string" && node["contentEncoding"] === "base64") {
        return true;
    }

    const { properties } = node;

    if (
        properties !== null &&
        typeof properties === "object" &&
        Object.values(properties as Record<string, unknown>).some((child) => hasUnrepresentableWireType(child, depth + 1))
    ) {
        return true;
    }

    // `allOf`/`anyOf`/`oneOf` hold arrays; the array branch above recurses them.
    return ["additionalProperties", "allOf", "anyOf", "items", "oneOf"].some((key) => hasUnrepresentableWireType(node[key], depth + 1));
};

/** Parse one OpenRPC method. Model names are derived HERE and nowhere else. */
const parseMethod = (method: OpenRpcMethod): SdkMethod => {
    const [namespace = "", functionName = ""] = method.name.split(":");
    const base = `${toPascalCase(namespace)}${toPascalCase(functionName)}`;

    const argsSchema = method.params?.[0]?.schema;
    const resultSchema = method.result?.schema;

    // A schema carrying a bigint or bytes gets NO generated model: the field
    // would render as a plain number/string and every call would fail the
    // server's validator. The caller passes wire values directly instead.
    return {
        argsType: isTypedSchema(argsSchema) && !hasUnrepresentableWireType(argsSchema) ? `${base}Args` : undefined,
        functionName,
        functionPath: method.name,
        namespace,
        resultType: isTypedSchema(resultSchema) && !hasUnrepresentableWireType(resultSchema) ? `${base}Result` : undefined,
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

/** A generated identifier must start with a letter and continue alphanumerically. */
const VALID_IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*$/u;

/** Whether `candidate` is a legal identifier in every target language. */
const isValidIdentifier = (candidate: string): boolean => VALID_IDENTIFIER.test(candidate);

/**
 * Reject a document that cannot produce valid, unambiguous source.
 *
 * Two failures, both of which emit code that does not compile rather than code
 * that is merely wrong, and neither of which any downstream gate would catch:
 *
 * **Invalid identifiers.** A namespace may legally begin with a digit
 * (`lunora/2fa.ts` → `2fa`, see `paths.ts`), and `toPascalCase` preserves it.
 * `class 2faApi:` and `type 2faAPI struct` are syntax errors everywhere.
 *
 * **Collisions.** `toPascalCase` is not injective: `user_profile` and
 * `userProfile` both yield `UserProfile`. That renders two classes of the same
 * name — a duplicate declaration in Go, and in Python a silent shadow where the
 * second definition wins and one namespace's methods vanish.
 *
 * Throwing beats emitting: a caller renames the file, where the ambiguity
 * actually lives, instead of debugging generated source.
 */
const assertGeneratable = (namespaces: ReadonlyArray<SdkNamespace>): void => {
    const seenNamespace = new Map<string, string>();

    for (const namespace of namespaces) {
        const typeName = toPascalCase(namespace.name);

        if (!isValidIdentifier(typeName)) {
            throw new Error(`sdk: namespace "${namespace.name}" produces the invalid identifier "${typeName}" — rename the file so it starts with a letter.`);
        }

        const clash = seenNamespace.get(typeName);

        if (clash !== undefined) {
            throw new Error(
                `sdk: namespaces "${clash}" and "${namespace.name}" both generate "${typeName}" — rename one so the generated types stay distinct.`,
            );
        }

        seenNamespace.set(typeName, namespace.name);

        const seenMethod = new Map<string, string>();

        for (const method of namespace.methods) {
            const memberBase = toPascalCase(method.functionName);

            if (!isValidIdentifier(memberBase)) {
                throw new Error(
                    `sdk: function "${method.functionPath}" produces the invalid identifier "${memberBase}" — rename the export so it starts with a letter.`,
                );
            }

            const memberClash = seenMethod.get(memberBase);

            if (memberClash !== undefined) {
                throw new Error(
                    `sdk: functions "${memberClash}" and "${method.functionPath}" both generate "${memberBase}" — rename one so the generated methods stay distinct.`,
                );
            }

            seenMethod.set(memberBase, method.functionPath);
        }
    }
};

/** Every method in the document, flattened — for imports and summary counts. */
const allMethods = (namespaces: ReadonlyArray<SdkNamespace>): ReadonlyArray<SdkMethod> => namespaces.flatMap((namespace) => namespace.methods);

/**
 * The two sentences every generated file opens with.
 *
 * Returned as lines rather than formatted text because the wrapper differs by
 * language in ways a comment prefix cannot express — Python wants a module
 * docstring, Go a `//` run. Sharing the sentences is the point; N copies of one
 * sentence drift, and the wrapper is one `map` at the call site.
 */
const generatedHeaderLines = (languageId: string): ReadonlyArray<string> => [
    `GENERATED by \`lunora sdk generate --lang ${languageId}\` — do not edit.`,
    `Run the command again to regenerate.`,
];

/**
 * Clear model references the rendered models do not actually declare.
 *
 * {@link parseMethod} predicts a name for every typed schema, but quicktype —
 * not this package — decides whether that name becomes a declared type, and the
 * answer differs by backend. A `.output(v.string())` renders as
 * `type MessagesCountResult string` in Go (a real named type) but in Python as
 * a bare `messages_count_result_from_dict()` helper with NO class of that name.
 * Emitting the prediction regardless produces an SDK that fails to import.
 *
 * So the prediction is reconciled against the rendered source rather than
 * trusted. The test is deliberately the weakest one that is still sound: a name
 * that appears nowhere in the models text is certainly not declared, and that
 * is exactly the failure. Anything stricter would mean parsing generated source
 * per language — nine more things to get wrong — and anything that instead
 * narrowed the prediction would bake one backend's current behaviour into the
 * language-neutral layer.
 *
 * A cleared reference degrades to the untyped return the surface already
 * renders for an undeclared `.output()`, so the worst case is a weaker type,
 * never a broken build.
 */
const withDeclaredModels = (namespaces: ReadonlyArray<SdkNamespace>, models: string): ReadonlyArray<SdkNamespace> => {
    // Word-bounded: a bare `includes` counts `FooArgs` as declared whenever
    // `FooArgsResult` appears in the text — reachable when one function is
    // named `list` and a sibling `listArgs` — and a false positive emits a
    // reference to a type the backend never declared.
    const declared = (name: string | undefined): string | undefined =>
        name !== undefined && new RegExp(String.raw`\b${name}\b`, "u").test(models) ? name : undefined;

    return namespaces.map((namespace) => {
        return {
            methods: namespace.methods.map((method) => {
                return { ...method, argsType: declared(method.argsType), resultType: declared(method.resultType) };
            }),
            name: namespace.name,
        };
    });
};

/**
 * Functions whose args or result carry a bigint/bytes, so no typed model was
 * generated for them. Reported by the CLI: the surface silently taking an
 * untyped parameter would otherwise look like an oversight rather than a
 * deliberate, documented limitation.
 */
const unrepresentableFunctions = (document: OpenRpcDocument): ReadonlyArray<string> =>
    document.methods
        .filter((method) => hasUnrepresentableWireType(method.params?.[0]?.schema) || hasUnrepresentableWireType(method.result?.schema))
        .map((method) => method.name)
        .toSorted((a, b) => a.localeCompare(b));

/** Model names that were predicted but not declared — reported by the CLI. */
const undeclaredModels = (namespaces: ReadonlyArray<SdkNamespace>, models: string): ReadonlyArray<string> =>
    [
        ...new Set(
            allMethods(namespaces)
                .flatMap((method) => [method.argsType, method.resultType])
                .filter((name): name is string => name !== undefined && !new RegExp(String.raw`\b${name}\b`, "u").test(models)),
        ),
    ].toSorted((a, b) => a.localeCompare(b));

/** The model names a surface actually references, de-duplicated and sorted. */
const referencedModels = (namespaces: ReadonlyArray<SdkNamespace>): ReadonlyArray<string> =>
    [
        ...new Set(
            allMethods(namespaces)
                .flatMap((method) => [method.argsType, method.resultType])
                .filter((name): name is string => name !== undefined),
        ),
    ].toSorted((a, b) => a.localeCompare(b));

export {
    allMethods,
    assertGeneratable,
    generatedHeaderLines,
    hasUnrepresentableWireType,
    isTypedSchema,
    modelSources,
    parseMethod,
    parseSpec,
    referencedModels,
    toPascalCase,
    toSnakeCase,
    undeclaredModels,
    unrepresentableFunctions,
    verbForKind,
    withDeclaredModels,
};
export type { OpenRpcDocument, OpenRpcMethod, RuntimeVerb, SdkMethod, SdkNamespace };
