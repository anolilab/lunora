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
    /**
     * Where this function's ARGUMENT nulls mean "unset" and where they mean
     * "null" — see {@link ModelNullPaths}.
     *
     * On the method rather than on a shared render input because it is a
     * per-method fact and the parser already holds the schema it comes from. Read
     * by the three targets whose rendered models cannot tell the two apart
     * (ruby, rust, swift); the other five have a marker of their own and ignore
     * it.
     */
    argsNullPaths: ModelNullPaths;

    /**
     * Generated args model name, or `undefined` when NO model could be named for
     * this function's arguments.
     *
     * `undefined` does NOT mean "takes no arguments" — see {@link SdkMethod.takesArgs}.
     * A schema carrying a `v.bigint()` or `v.bytes()` gets no model deliberately
     * (`hasUnrepresentableWireType`), and a backend that cannot name a shape leaves
     * it undeclared. Both still take arguments, just untyped ones.
     */
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

    /**
     * Whether this function declares arguments at all, independent of whether a
     * model could be named for them.
     *
     * A target emits three shapes from this: a TYPED parameter when `argsType` is
     * set, an UNTYPED wire-shaped parameter when it is not but this is true, and no
     * parameter at all when this is false. Collapsing the middle case into the last
     * is what made `v.bigint()` functions uncallable with arguments.
     */
    takesArgs: boolean;
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

/**
 * Neutralise document text that is about to be interpolated into a comment.
 *
 * `summary`, `functionPath` and `namespace` come from a document that is
 * normally generated but can be hand-supplied via `--spec`, and every target
 * interpolates them into comments. A newline ends a line comment and drops
 * whatever follows into executable position; a block-comment terminator does the
 * same for Java/Kotlin, and `\u0022\u0022\u0022` for a Python docstring.
 * Collapsing to one line and pulling those terminators apart covers all seven
 * languages at once. U+2028/U+2029 are included because they terminate a line in
 * some tooling even where the language proper does not treat them as one.
 */
const commentText = (value: string): string =>
    value
        .replaceAll(/[\n\r\u2028\u2029]+/gu, " ")
        .replaceAll("*/", "* /")
        .replaceAll("\u0022\u0022\u0022", "\u0022 \u0022\u0022");

/**
 * Escape a value for a double-quoted string literal in a C-family language.
 *
 * Kotlin interpolates `$` and Ruby interpolates `#{`; those two targets layer
 * their own escape on top of this one.
 */
const stringLiteral = (value: string): string =>
    value.replaceAll("\u005C", "\u005C\u005C").replaceAll('"', '\u005C"').replaceAll("\n", "\u005Cn").replaceAll("\r", "\u005Cr");

/**
 * The Kotlin escape for a literal dollar, assembled from parts so the sequence
 * never appears as a template-looking literal in this file.
 */
const DOLLAR_ESCAPE = ["$", "{", "'", "$", "'", "}"].join("");

/**
 * Escape a value for a Kotlin `"…"` literal.
 *
 * Kotlin interpolates `$`, and `$` is a legal JavaScript identifier character, so
 * an export named `$client` produced `"billing:$client"` — which compiles, runs,
 * and posts the client object's `toString()` as the wire path. A wire KEY carries
 * one just as easily, since it comes from a user's own `v.object({ … })`.
 *
 * Layered ON TOP of {@link stringLiteral} rather than repeating its rules:
 * escaping backslashes in both would emit a literal that decodes to two of them.
 * The dollar pass runs last, so the escape it inserts is not itself re-escaped.
 *
 * Lives here rather than in `targets/kotlin.ts` because the Kotlin MODEL emitter
 * needs it too and may not import from a target — the targets import the models.
 */
const kotlinLiteral = (value: string): string => stringLiteral(value).split("$").join(DOLLAR_ESCAPE);

/**
 * Pick one of the three argument shapes a target must emit for a method.
 *
 * `typed` — a model was named, take it. `untyped` — the function takes arguments
 * that no model can express (`v.bigint()`/`v.bytes()`, or a shape the backend could
 * not name), so take a wire-shaped value. `none` — the function takes no arguments.
 *
 * Named rather than left as a conditional at each call site because collapsing
 * `untyped` into `none` is precisely the bug this exists to prevent: five targets
 * did that and made those functions uncallable with arguments.
 */
const argsChoice = <T>(method: SdkMethod, choices: { none: T; typed: (type: string) => T; untyped: T }): T => {
    if (method.argsType !== undefined) {
        return choices.typed(method.argsType);
    }

    return method.takesArgs ? choices.untyped : choices.none;
};

/**
 * A path from a model's root to one property. `*` stands for every element of an
 * array or every value of a record, neither of which has named positions.
 */
type SchemaPath = ReadonlyArray<string>;

/**
 * Where a model's nulls mean different things — the one fact a generated model
 * flattens away, and the reason three ports could not send a `v.nullable()`
 * argument at all.
 *
 * An unset `v.optional()` and a `v.nullable()` set to null are the SAME value in
 * every generated model (a nil field), and opposite things on the wire: the
 * validator rejects an explicit null for the first and requires the key present
 * for the second. Neither Ruby, Rust nor Swift renders a marker telling them
 * apart, so the distinction is computed here, from the schema, where `required`
 * still exists — and handed to the targets that need it.
 *
 * Two lists rather than one because the ports need opposite operations. Ruby and
 * Rust project a whole value tree and prune nulls, so they prune at
 * {@link ModelNullPaths.optional} and nowhere else — which also stops them
 * dropping a legitimate null inside a record or an array, as a blanket prune
 * does. Swift's `JSONEncoder` has already dropped every struct-property nil
 * before the transport sees a tree, so it restores nulls at
 * {@link ModelNullPaths.nullable} instead: an absent key at a required path can
 * only have been a nil, so putting the null back is exact.
 *
 * A `$ref` is NOT resolved. `openrpc.ts` inlines everything it emits, so this
 * never comes up for a generated document — but `--spec` accepts a hand-written
 * one, and there a `$ref`'d sub-object contributes no paths at all: the ports
 * that prune would send its unset optionals as null, and Swift would not restore
 * its nullables. Inline the schema, or teach this to follow the pointer.
 *
 * Both lists name PROPERTIES only. A record's values and an array's elements can
 * be null too, but no port drops one: the pruning ports prune at `optional`
 * paths, which a `*` position can never be, and `JSONEncoder` drops a nil only
 * from a struct property — a nil inside a dictionary or array encodes as null.
 * Listing a `*` leaf would also make Swift's restore INVENT record keys that
 * were never there, which is why the walk records the path it descends through
 * but never the `*` position itself.
 */
interface ModelNullPaths {
    /** Required properties that permit null — a null there is a VALUE and must survive. */
    nullable: ReadonlyArray<SchemaPath>;
    /** Properties absent from their object's `required` — a null there means UNSET. */
    optional: ReadonlyArray<SchemaPath>;
}

/** Bounds the schema walk; a real args schema is far shallower, and a `$ref` cycle must not hang codegen. */
const MAX_SCHEMA_DEPTH = 32;

/**
 * Whether `schema` accepts an explicit null.
 *
 * `.nullable()` renders as `{ anyOf: [inner, { type: "null" }] }` and
 * `v.union(v.null(), …)` as an `anyOf` carrying the same branch, so the test is
 * the branch rather than a flag. A bare `{ type: "null" }` and the JSON Schema
 * type-array spelling are accepted too — neither is what this repo emits, but
 * `--spec` takes a hand-written document.
 */
const permitsNull = (schema: unknown, depth = 0): boolean => {
    if (depth > MAX_SCHEMA_DEPTH || schema === null || typeof schema !== "object") {
        return false;
    }

    const node = schema as Record<string, unknown>;

    if (node["type"] === "null" || (Array.isArray(node["type"]) && node["type"].includes("null"))) {
        return true;
    }

    return ["anyOf", "oneOf"].some((key) => {
        const branches = node[key];

        return Array.isArray(branches) && branches.some((branch) => permitsNull(branch, depth + 1));
    });
};

/** The accumulator the walk below appends to. */
interface NullPathSink {
    nullable: string[][];
    optional: string[][];
}

/** One object shape a node contributes: its properties and which of them it requires. */
interface ObjectShape {
    properties: Record<string, unknown>;
    required: Set<string>;
}

/**
 * Fold what a node states itself into each of its alternatives.
 *
 * With no alternatives the node IS the shape — unless it declared nothing at
 * all, in which case there is no shape to speak of.
 */
const mergeAlternatives = (base: ObjectShape, alternatives: ObjectShape[], conjunctCount: number): ObjectShape[] => {
    if (alternatives.length === 0) {
        return conjunctCount === 0 ? [] : [base];
    }

    return alternatives.map((alternative) => {
        return {
            properties: { ...base.properties, ...alternative.properties },
            required: new Set([...base.required, ...alternative.required]),
        };
    });
};

/**
 * The object shapes quicktype will MERGE into a single class for this node.
 *
 * This is the part that cannot be read off one `required` list, and getting it
 * wrong regresses working calls. quicktype folds the branches of an `anyOf` into
 * ONE class whose every property is nullable unless every branch requires it —
 * so for `v.union(v.object({a}), v.object({b}))` it renders one class with `a`
 * and `b` both optional, and a model built from it emits BOTH, one of them null.
 * A walk that read each branch's own `required` in isolation would call both
 * properties required, prune nothing, and send `{"a":"x","b":null}` — which
 * neither branch of the union accepts.
 *
 * So an `anyOf`/`oneOf` yields one shape PER BRANCH and the caller intersects:
 * a property is required only where every shape both has it and requires it. A
 * non-object branch — the `{ type: "null" }` of a `.nullable()`, say — yields no
 * shape at all, so wrapping an object in `.nullable()` does not make its
 * properties optional. An `allOf` is a conjunction rather than a choice, so its
 * branches fold INTO the surrounding shape instead of standing beside it.
 */
/** The shape a node declares directly, if it declares one. */
const ownShape = (node: Record<string, unknown>): ObjectShape[] => {
    const { properties } = node;

    if (properties === null || typeof properties !== "object") {
        return [];
    }

    const declared = node["required"];

    return [
        {
            properties: properties as Record<string, unknown>,
            required: new Set(Array.isArray(declared) ? declared.filter((key): key is string => typeof key === "string") : []),
        },
    ];
};

/** The shapes under one combinator key. */
const branchShapes = (node: Record<string, unknown>, key: string, depth: number): ObjectShape[] => {
    const branches = node[key];

    if (!Array.isArray(branches)) {
        return [];
    }

    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutually recursive with the collector below
    return branches.flatMap((branch) => objectShapes(branch, depth + 1));
};

const objectShapes = (schema: unknown, depth = 0): ObjectShape[] => {
    if (depth > MAX_SCHEMA_DEPTH || schema === null || typeof schema !== "object") {
        return [];
    }

    const node = schema as Record<string, unknown>;
    // `allOf` branches all hold at once, so they merge into the shape here rather
    // than becoming alternatives beside it.
    const conjuncts = [...ownShape(node), ...branchShapes(node, "allOf", depth)];

    const base: ObjectShape = {
        properties: Object.assign({}, ...conjuncts.map((shape) => shape.properties)) as Record<string, unknown>,
        required: new Set(conjuncts.flatMap((shape) => [...shape.required])),
    };

    const alternatives = [...branchShapes(node, "anyOf", depth), ...branchShapes(node, "oneOf", depth)];

    return mergeAlternatives(base, alternatives, conjuncts.length);
};

/** Every node whose `items`/`additionalProperties` this one's `*` position covers. */
const wildcardSources = (schema: unknown, depth = 0): Record<string, unknown>[] => {
    if (depth > MAX_SCHEMA_DEPTH || schema === null || typeof schema !== "object") {
        return [];
    }

    const node = schema as Record<string, unknown>;
    const sources = [node];

    for (const key of ["anyOf", "oneOf", "allOf"]) {
        const branches = node[key];

        if (Array.isArray(branches)) {
            for (const branch of branches) {
                sources.push(...wildcardSources(branch, depth + 1));
            }
        }
    }

    return sources;
};

const collectNullPaths = (schema: unknown, prefix: ReadonlyArray<string>, into: NullPathSink, depth = 0): void => {
    if (depth > MAX_SCHEMA_DEPTH || schema === null || typeof schema !== "object") {
        return;
    }

    const shapes = objectShapes(schema);
    const keys = [...new Set(shapes.flatMap((shape) => Object.keys(shape.properties)))].toSorted((a, b) => a.localeCompare(b));

    for (const key of keys) {
        const path = [...prefix, key];
        // Present AND required in every merged shape. A shape that lacks the key
        // fails the test on its own, which is what makes a property missing from
        // one union branch optional in the class quicktype renders.
        const required = shapes.every((shape) => shape.required.has(key));
        const children = shapes.map((shape) => shape.properties[key]).filter((child) => child !== undefined);

        if (!required) {
            into.optional.push(path);
        } else if (children.some((child) => permitsNull(child))) {
            into.nullable.push(path);
        }

        for (const child of children) {
            collectNullPaths(child, path, into, depth + 1);
        }
    }

    // A record's values and an array's elements take the `*` segment. The `*`
    // position ITSELF is never recorded: no port drops a null there, and listing
    // one would make Swift's restore invent record keys that were never sent.
    // `additionalProperties: false` is a boolean and falls out of the type test.
    for (const source of wildcardSources(schema)) {
        for (const key of ["additionalProperties", "items"]) {
            const child = source[key];

            if (child !== null && typeof child === "object") {
                collectNullPaths(child, [...prefix, "*"], into, depth + 1);
            }
        }
    }
};

/** Sorted so two runs over one schema emit byte-identical paths. */
const byPath = (a: SchemaPath, b: SchemaPath): number => a.join("\u0000").localeCompare(b.join("\u0000"));

/**
 * The {@link ModelNullPaths} of one schema.
 *
 * Exported for `__tests__/sdk-null-paths.test.ts`, which exercises the walk
 * directly — every other caller reaches it through {@link SdkMethod.argsNullPaths}.
 */
const nullPathsOf = (schema: unknown): ModelNullPaths => {
    const into: NullPathSink = { nullable: [], optional: [] };

    collectNullPaths(schema, [], into);

    // Merged alternatives can reach one property by more than one route, and the
    // same nested object can be walked once per branch that carries it.
    const distinct = (paths: string[][]): string[][] => [...new Map(paths.map((path) => [path.join("\u0000"), path])).values()].toSorted(byPath);

    return { nullable: distinct(into.nullable), optional: distinct(into.optional) };
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
        argsNullPaths: nullPathsOf(argsSchema),
        argsType: isTypedSchema(argsSchema) && !hasUnrepresentableWireType(argsSchema) ? `${base}Args` : undefined,
        takesArgs: isTypedSchema(argsSchema),
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
const assertMethodsGeneratable = (namespace: SdkNamespace): void => {
    // Both a method and its subscription land in this one map: a namespace with a
    // query `list` and a sibling `subscribeList` otherwise passes validation and
    // then emits `SubscribeList` twice — a compile error in Go, a silent shadow
    // in Python.
    const seenMethod = new Map<string, string>();

    for (const method of namespace.methods) {
        const memberBase = toPascalCase(method.functionName);

        if (!isValidIdentifier(memberBase)) {
            throw new Error(
                `sdk: function "${method.functionPath}" produces the invalid identifier "${memberBase}" — rename the export so it starts with a letter.`,
            );
        }

        const names = method.verb === "query" ? [memberBase, `Subscribe${memberBase}`] : [memberBase];

        for (const name of names) {
            const clash = seenMethod.get(name);

            if (clash !== undefined) {
                throw new Error(
                    `sdk: functions "${clash}" and "${method.functionPath}" both generate "${name}" — rename one so the generated methods stay distinct.`,
                );
            }

            seenMethod.set(name, method.functionPath);
        }
    }
};

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

        assertMethodsGeneratable(namespace);
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

export type { ModelNullPaths, SchemaPath };
export {
    allMethods,
    argsChoice,
    assertGeneratable,
    commentText,
    generatedHeaderLines,
    hasUnrepresentableWireType,
    isTypedSchema,
    kotlinLiteral,
    modelSources,
    nullPathsOf,
    parseMethod,
    parseSpec,
    referencedModels,
    stringLiteral,
    toPascalCase,
    toSnakeCase,
    undeclaredModels,
    unrepresentableFunctions,
    verbForKind,
    withDeclaredModels,
};
export type { OpenRpcDocument, OpenRpcMethod, RuntimeVerb, SdkMethod, SdkNamespace };
