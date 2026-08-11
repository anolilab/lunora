/**
 * JSON Schema → Java and Kotlin models, emitted HERE rather than by quicktype.
 *
 * The other five targets delegate their data classes to quicktype (see
 * {@link file://./models.ts}). The two JVM targets cannot, and the reason is
 * measured rather than assumed — `targets/java.ts` carries the option-by-option
 * record. In one line: quicktype's JVM backends RENAME properties and, under
 * `just-types`, emit no mapping metadata, so a generated model cannot be projected
 * back onto the wire; the only complete mapping they offer costs a Jackson / Klaxon
 * / kotlinx dependency, and these transports are JDK-only by definition (the JVM
 * ships no JSON at all, which is why `Json.java` and `Json.kt` are hand-rolled).
 *
 * ## Why emitting them here is sound where quicktype is not
 *
 * The input is the JSON Schema, and **its property names ARE the wire names**. So
 * there is no renamer to fight and nothing to re-derive: `toWire()` and
 * `fromWire()` emit the schema's own key as a string literal, taken verbatim from
 * `properties`. A local field identifier is derived (a wire `some-key` cannot be a
 * Java field), but that derivation is COSMETIC — it never reaches the wire, so the
 * `channelId` → `channelID` class of defect is structurally impossible here.
 *
 * ## The type surface that actually reaches a model
 *
 * Bounded by `values/src/json-schema-core.ts`, which is the only producer:
 *
 * | schema                                  | Java                      | Kotlin           |
 * | --------------------------------------- | ------------------------- | ---------------- |
 * | `{type:"string"}` (also `id`/`storage`) | `String`                  | `String`         |
 * | `{type:"number"}` / `{type:"integer"}`  | `Double`                  | `Double`         |
 * | `{type:"boolean"}`                      | `Boolean`                 | `Boolean`        |
 * | `anyOf`/`oneOf` of string `const`s      | an enum keeping the value | ditto            |
 * | `{type:"object",properties}`            | a nested class            | ditto            |
 * | `{additionalProperties:<schema>}`       | `Map<String, T>`          | `Map<String, T>` |
 * | `{type:"array",items}`                  | `List<T>`                 | `List<T>`        |
 * | anything else (`{}`, a non-const union) | `Object`                  | `WireValue`      |
 *
 * `v.date()`/`v.timestamp()` schema as a plain integer and are genuinely
 * epoch-milliseconds on the wire, so `Double` is correct for them. `v.bigint()` and
 * `v.bytes()` never arrive: `hasUnrepresentableWireType` walks `properties`,
 * `items`, `additionalProperties` and every `allOf`/`anyOf`/`oneOf` branch, and
 * `parseMethod` drops the model name entirely for any schema carrying one — so
 * {@link modelSources} never yields such a pair. That refusal is relied on rather
 * than repeated; the one place it thins out is depth, where it stops looking past
 * 32 levels, which is why {@link MAX_DEPTH} here stops typing well before that and
 * degrades to the untyped leaf.
 *
 * ## Optionality is the bug this file is most careful about
 *
 * A property absent from `required` is `v.optional(x)`, which parses `undefined`
 * or `x` and **REJECTS null**. So an unset optional must be OMITTED from the wire
 * map, never sent as an explicit null — Ruby and Rust both shipped that defect,
 * and it fails every call that leaves an optional unset. A `.nullable()` property
 * is the opposite: `{anyOf:[inner,{type:"null"}]}`, required, and an explicit null
 * is exactly what it wants.
 *
 * ponytail: a property that is BOTH optional and nullable cannot distinguish the
 * two — null means "omit" here, so an intended explicit null arrives as
 * `undefined`. Both pass the server's validator, so no call fails; a write that
 * meant "set this column to null" instead means "leave it alone". Upgrade path: a
 * null sentinel usable as a field value in all seven transports, which is a change
 * to seven hand-written ports for a shape nothing in this repo currently declares.
 *
 * ## Where the two languages deliberately differ
 *
 * Kotlin declares a required property non-null, so a payload that omits or
 * mistypes one cannot be represented and `fromWire` throws. Java has no such
 * declaration: the field is simply null. Both are the honest reading of their own
 * type system, and neither invents a value.
 */

import type { OpenRpcDocument } from "./spec";
import { commentText, kotlinLiteral, modelSources, stringLiteral, toPascalCase } from "./spec";

/**
 * The package the models live in — a sub-package of the surface's, so `javac`
 * resolves them off `-sourcepath` and the emitted files sort away from `Api.java`.
 */
const MODEL_PACKAGE = "lunoraapi.models";

/** The directory that package resolves to, relative to the output root. */
const MODEL_DIRECTORY = "lunoraapi/models";

/**
 * How deep a schema is typed before the walk degrades to the untyped leaf.
 *
 * Deliberately below the 32 levels `hasUnrepresentableWireType` inspects. That
 * guard returns `false` past its own limit, so a `v.bigint()` hidden deeper than
 * 32 levels is NOT refused a model — and a typed field there would encode it as a
 * plain number and fail the server's validator on every call. Stopping first means
 * anything that deep lands inside an `Object`/`WireValue` the caller fills with a
 * wire value, which is correct for a bigint as well as for everything else.
 */
const MAX_DEPTH = 24;

/**
 * Identifiers a generated field must not take: the hard keywords of both languages
 * (one union, because a field name is cosmetic and two lists would drift), plus the
 * members every generated model declares.
 */
const RESERVED_NAMES = new Set([
    "abstract",
    "as",
    "assert",
    "boolean",
    "break",
    "byte",
    "case",
    "catch",
    "char",
    "class",
    "const",
    "continue",
    "default",
    "do",
    "double",
    "else",
    "enum",
    "extends",
    "false",
    "final",
    "finally",
    "float",
    "for",
    "fromWire",
    "fun",
    "goto",
    "if",
    "implements",
    "import",
    "in",
    "instanceof",
    "int",
    "interface",
    "is",
    "long",
    "native",
    "new",
    "null",
    "object",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "short",
    "static",
    "strictfp",
    "super",
    "switch",
    "synchronized",
    "this",
    "throw",
    "throws",
    "toWire",
    "transient",
    "true",
    "try",
    "typealias",
    "typeof",
    "val",
    "var",
    "void",
    "volatile",
    "when",
    "while",
    "wireValue",
]);

const NON_ALPHANUMERIC = /[^A-Za-z0-9]+/gu;
const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/gu;
const LEADING_LETTER = /^[A-Za-z]/u;
const LEADING_UPPERCASE = /^[A-Z]/u;

/** A JVM type a generated field can carry. */
type JvmType =
    | { item: JvmType; kind: "list" }
    | { kind: "boolean" }
    | { kind: "class"; name: string }
    | { kind: "enum"; name: string }
    | { kind: "number" }
    | { kind: "record"; value: JvmType }
    | { kind: "string" }
    | { kind: "unknown" };

/** One property of a model. `wireKey` is the schema's own and is never transformed. */
interface JvmField {
    /** The local identifier. Cosmetic — see the file header. */
    name: string;
    /** Accepts an explicit null (`.nullable()`), which is sent rather than omitted. */
    nullable: boolean;
    /** Absent from `required`: unset means the key is OMITTED from the wire map. */
    optional: boolean;
    type: JvmType;
    /** The literal key emitted into `toWire`/`fromWire`. */
    wireKey: string;
}

interface JvmClass {
    fields: ReadonlyArray<JvmField>;
    kind: "class";
    name: string;
}

interface JvmEnum {
    constants: ReadonlyArray<{ name: string; wireValue: string }>;
    kind: "enum";
    name: string;
}

type JvmDeclaration = JvmClass | JvmEnum;

/**
 * Raised when two declarations in one document want the same name, which would be
 * a duplicate class. Caught per top-level model, which is then skipped entirely and
 * reported as undeclared — the surface degrades to an untyped value rather than
 * referencing one of two colliding types.
 */
class ModelNameConflict extends Error {}

/** A schema node, or undefined when the value is not one. */
const schemaOf = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * The string `const`s of an `anyOf`/`oneOf`, or undefined when it is not one.
 *
 * Every branch must carry a string `const`. A mixed or numeric union is left
 * untyped rather than guessed at: an enum whose constants do not cover the wire's
 * actual values would reject a legal server response.
 */
const constUnion = (schema: Record<string, unknown>): ReadonlyArray<string> | undefined => {
    const branches = schema["anyOf"] ?? schema["oneOf"];

    if (!Array.isArray(branches) || branches.length === 0) {
        return undefined;
    }

    const values = branches.map((branch) => schemaOf(branch)?.["const"]);

    if (!values.every((value) => typeof value === "string")) {
        return undefined;
    }

    return [...new Set(values as ReadonlyArray<string>)].toSorted((a, b) => a.localeCompare(b));
};

/**
 * Unwrap a `.nullable()` widening — `{anyOf:[inner,{type:"null"}]}` → `inner` — or
 * return the node unchanged.
 */
const withoutNull = (schema: Record<string, unknown>): Record<string, unknown> => {
    const branches = schema["anyOf"] ?? schema["oneOf"];

    if (!Array.isArray(branches) || branches.length !== 2) {
        return schema;
    }

    const nonNull = branches.filter((branch) => schemaOf(branch)?.["type"] !== "null");

    return nonNull.length === 1 ? (schemaOf(nonNull[0]) ?? schema) : schema;
};

/** A wire key as a local identifier: `some-key` → `someKey`, `2fa` → `value2fa`. */
const fieldName = (wireKey: string): string => {
    const pascal = toPascalCase(wireKey);
    const camel = pascal.charAt(0).toLowerCase() + pascal.slice(1);
    const legal = LEADING_LETTER.test(camel) ? camel : `value${pascal}`;

    return RESERVED_NAMES.has(legal) ? `${legal}_` : legal;
};

/** A wire value as an enum constant: `some-key` → `SOME_KEY`, `2fa` → `VALUE_2FA`. */
const constantName = (wireValue: string): string => {
    // The trailing split/join strips a leading or trailing underscore. `^_+|_+$`
    // would too, but as a super-linear pattern over caller-supplied text.
    const upper = wireValue
        .replaceAll(CAMEL_BOUNDARY, "$1_$2")
        .replaceAll(NON_ALPHANUMERIC, "_")
        .toUpperCase()
        .split("_")
        .filter((part) => part.length > 0)
        .join("_");

    return LEADING_UPPERCASE.test(upper) ? upper : `VALUE_${upper}`;
};

/**
 * Make `candidate` unique against `taken`, deterministically.
 *
 * Reached when two distinct wire keys mangle to one identifier (`some-key` and
 * `someKey` both give `someKey`). Suffixing is safe here in a way it would not be
 * for a wire key: the identifier is local, and both fields still carry their own
 * verbatim key into `toWire`.
 */
const uniqueName = (candidate: string, taken: Set<string>): string => {
    if (!taken.has(candidate)) {
        taken.add(candidate);

        return candidate;
    }

    let suffix = 2;

    while (taken.has(`${candidate}${String(suffix)}`)) {
        suffix += 1;
    }

    taken.add(`${candidate}${String(suffix)}`);

    return `${candidate}${String(suffix)}`;
};

/** Register a declaration, refusing a name another declaration already holds. */
const declare = (declarations: Map<string, JvmDeclaration>, declaration: JvmDeclaration): void => {
    if (declarations.has(declaration.name)) {
        throw new ModelNameConflict(`sdk: two schemas both produce the JVM model "${declaration.name}"`);
    }

    declarations.set(declaration.name, declaration);
};

/** The fields of an object schema, in the schema's own property order. */
const fieldsFor = (
    properties: Record<string, unknown>,
    required: unknown,
    owner: string,
    depth: number,
    declarations: Map<string, JvmDeclaration>,
): ReadonlyArray<JvmField> => {
    const requiredKeys = new Set(Array.isArray(required) ? required.filter((key): key is string => typeof key === "string") : []);
    const taken = new Set<string>();

    return Object.entries(properties).map(([wireKey, raw]) => {
        const schema = schemaOf(raw) ?? {};
        const optional = !requiredKeys.has(wireKey);

        return {
            name: uniqueName(fieldName(wireKey), taken),
            nullable: !optional && withoutNull(schema) !== schema,
            optional,
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- see above
            type: typeFor(schema, `${owner}${toPascalCase(wireKey)}`, depth + 1, declarations),
            wireKey,
        };
    });
};

/**
 * The JVM type for `schema`, registering any class or enum it needs along the way.
 *
 * `name` is the name a class or enum discovered at this position takes — derived
 * from the owning model plus the property path, so it is stable across runs.
 */
const typeFor = (schema: Record<string, unknown>, name: string, depth: number, declarations: Map<string, JvmDeclaration>): JvmType => {
    if (depth >= MAX_DEPTH) {
        return { kind: "unknown" };
    }

    const values = constUnion(schema);

    if (values !== undefined) {
        const taken = new Set<string>();

        declare(declarations, {
            constants: values.map((wireValue) => {
                return { name: uniqueName(constantName(wireValue), taken), wireValue };
            }),
            kind: "enum",
            name,
        });

        return { kind: "enum", name };
    }

    const unwrapped = withoutNull(schema);

    if (unwrapped !== schema) {
        return typeFor(unwrapped, name, depth + 1, declarations);
    }

    const properties = schemaOf(schema["properties"]);

    if (properties !== undefined) {
        declare(declarations, { fields: fieldsFor(properties, schema["required"], name, depth, declarations), kind: "class", name });

        return { kind: "class", name };
    }

    const additional = schemaOf(schema["additionalProperties"]);

    if (additional !== undefined) {
        return { kind: "record", value: typeFor(additional, `${name}Value`, depth + 1, declarations) };
    }

    const items = schemaOf(schema["items"]);

    if (items !== undefined) {
        return { item: typeFor(items, `${name}Item`, depth + 1, declarations), kind: "list" };
    }

    switch (schema["type"]) {
        case "boolean": {
            return { kind: "boolean" };
        }
        case "integer":
        case "number": {
            return { kind: "number" };
        }
        case "string": {
            return { kind: "string" };
        }
        default: {
            return { kind: "unknown" };
        }
    }
};

/**
 * Every declaration a document's models need, sorted by name.
 *
 * Only a top-level `properties` schema becomes a model. A scalar, array or record
 * result has no class it could be — Java has no type alias — so its predicted name
 * is left undeclared and `withDeclaredModels` degrades that call site to an untyped
 * return, exactly as it does for the quicktype backends that cannot name one.
 */
const jvmDeclarations = (document: OpenRpcDocument): ReadonlyArray<JvmDeclaration> => {
    const declarations = new Map<string, JvmDeclaration>();

    for (const source of modelSources(document)) {
        if (schemaOf(source.schema["properties"]) === undefined) {
            continue;
        }

        // Staged in its own map so a name conflict discards this model alone. A
        // partially-registered tree would leave a nested class no field declares,
        // which compiles as dead weight nothing can reach.
        const staged = new Map<string, JvmDeclaration>();

        try {
            typeFor(source.schema, source.name, 0, staged);
        } catch (error) {
            if (error instanceof ModelNameConflict) {
                continue;
            }

            throw error;
        }

        if ([...staged.keys()].some((name) => declarations.has(name))) {
            continue;
        }

        for (const [name, declaration] of staged) {
            declarations.set(name, declaration);
        }
    }

    return [...declarations.values()].toSorted((a, b) => a.name.localeCompare(b.name));
};

/** The two-line generated banner, as `//` comments. */
const generatedBanner = (languageId: string): ReadonlyArray<string> => [
    `// GENERATED by \`lunora sdk generate --lang ${languageId}\` — do not edit.`,
    `// Run the command again to regenerate.`,
];

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

const javaType = (type: JvmType): string => {
    switch (type.kind) {
        case "boolean": {
            return "Boolean";
        }
        case "class":
        case "enum": {
            return type.name;
        }
        case "list": {
            return `java.util.List<${javaType(type.item)}>`;
        }
        case "number": {
            return "Double";
        }
        case "record": {
            return `java.util.Map<String, ${javaType(type.value)}>`;
        }
        case "string": {
            return "String";
        }
        default: {
            return "Object";
        }
    }
};

/**
 * Whether a value of `type` needs converting before the wire codec sees it.
 *
 * `Wire.encode` already accepts `String`, `Double`, `Boolean`, `List` and `Map`, so
 * only a model, an enum, or a collection of one has anything to do.
 */
const javaNeedsEncode = (type: JvmType): boolean => {
    switch (type.kind) {
        case "class":
        case "enum": {
            return true;
        }
        case "list": {
            return javaNeedsEncode(type.item);
        }
        case "record": {
            return javaNeedsEncode(type.value);
        }
        default: {
            return false;
        }
    }
};

/** A Java expression turning `source` into a wire-shaped value. */
const javaEncode = (type: JvmType, source: string, depth: number): string => {
    if (!javaNeedsEncode(type)) {
        return source;
    }

    const item = `item${String(depth)}`;

    switch (type.kind) {
        case "class": {
            return `${source} == null ? null : ${source}.toWire()`;
        }
        case "enum": {
            return `${source} == null ? null : ${source}.toValue()`;
        }
        case "list": {
            return `ModelWire.writeList(${source}, ${item} -> ${javaEncode(type.item, item, depth + 1)})`;
        }
        case "record": {
            return `ModelWire.writeRecord(${source}, ${item} -> ${javaEncode(type.value, item, depth + 1)})`;
        }
        default: {
            // Unreachable: `javaNeedsEncode` returned true, and only the four cases
            // above can. Kept as the total-switch arm rather than a cast.
            return source;
        }
    }
};

/** A Java expression reading `source` (a decoded wire value) as `type`. */
const javaDecode = (type: JvmType, source: string, depth: number): string => {
    const item = `item${String(depth)}`;

    switch (type.kind) {
        case "boolean": {
            return `ModelWire.flag(${source})`;
        }
        case "class": {
            return `ModelWire.readObject(${source}, ${type.name}::fromWire)`;
        }
        case "enum": {
            return `ModelWire.readEnum(${source}, ${type.name}::forValue)`;
        }
        case "list": {
            return `ModelWire.readList(${source}, ${item} -> ${javaDecode(type.item, item, depth + 1)})`;
        }
        case "number": {
            return `ModelWire.number(${source})`;
        }
        case "record": {
            return `ModelWire.readRecord(${source}, ${item} -> ${javaDecode(type.value, item, depth + 1)})`;
        }
        case "string": {
            return `ModelWire.text(${source})`;
        }
        default: {
            return source;
        }
    }
};

const javaFieldDocument = (field: JvmField): ReadonlyArray<string> => {
    const key = commentText(field.wireKey);

    if (field.optional) {
        return [
            `    /**`,
            `     * Wire key {@code ${key}} — OPTIONAL: null omits the key entirely, because`,
            `     * \`v.optional\` accepts the value or \`undefined\` and rejects an explicit null.`,
            `     */`,
        ];
    }

    return [`    /** Wire key {@code ${key}}.${field.nullable ? " Nullable: null is sent as an explicit null." : ""} */`];
};

/** The 100-column limit `google-java-format --aosp` wraps at. */
const JAVA_LINE_LIMIT = 100;

/**
 * A constructor signature, wrapped one parameter per line once the single-line form
 * would run past {@link JAVA_LINE_LIMIT}. Generated source is not lint-gated (see
 * `sdks/lint-all.sh`), but a 200-column constructor is still something a consumer
 * has to read.
 */
const javaConstructorSignature = (model: JvmClass): ReadonlyArray<string> => {
    const parameters = model.fields.map((field) => `${javaType(field.type)} ${field.name}`);
    const oneLine = `    public ${model.name}(${parameters.join(", ")}) {`;

    if (oneLine.length <= JAVA_LINE_LIMIT) {
        return [oneLine];
    }

    return [`    public ${model.name}(`, ...parameters.map((parameter, index) => `            ${parameter}${index === parameters.length - 1 ? ") {" : ","}`)];
};

const javaClassFile = (model: JvmClass): string => {
    const puts = model.fields.flatMap((field) => {
        const put = `wire.put("${stringLiteral(field.wireKey)}", ${javaEncode(field.type, `this.${field.name}`, 0)});`;

        return field.optional ? [`        if (this.${field.name} != null) {`, `            ${put}`, `        }`] : [`        ${put}`];
    });

    const reads = model.fields.map((field) => `                ${javaDecode(field.type, `wire.get("${stringLiteral(field.wireKey)}")`, 0)}`);

    return [
        ...generatedBanner("java"),
        ``,
        `package ${MODEL_PACKAGE};`,
        ``,
        `/**`,
        ` * The \`${model.name}\` model.`,
        ` *`,
        ` * <p>Field names are local; the keys {@link #toWire()} and {@link #fromWire(Object)} use are`,
        ` * the schema's own, emitted verbatim, so a renamed field cannot reach the wire.`,
        ` */`,
        `public final class ${model.name} {`,
        ...model.fields.flatMap((field) => [...javaFieldDocument(field), `    public final ${javaType(field.type)} ${field.name};`, ``]),
        ...javaConstructorSignature(model),
        ...model.fields.map((field) => `        this.${field.name} = ${field.name};`),
        `    }`,
        ``,
        `    /** This model as the wire-shaped map the transport encodes. */`,
        `    public java.util.Map<String, Object> toWire() {`,
        `        java.util.Map<String, Object> wire = new java.util.LinkedHashMap<>();`,
        ...puts,
        ``,
        `        return wire;`,
        `    }`,
        ``,
        `    /** Rebuild from a decoded wire value. */`,
        `    public static ${model.name} fromWire(Object value) {`,
        `        java.util.Map<String, Object> wire = ModelWire.object(value);`,
        ``,
        ...(reads.length === 0 ? [`        return new ${model.name}();`] : [`        return new ${model.name}(`, `${reads.join(",\n")});`]),
        `    }`,
        `}`,
        ``,
    ].join("\n");
};

const javaEnumFile = (model: JvmEnum): string =>
    [
        ...generatedBanner("java"),
        ``,
        `package ${MODEL_PACKAGE};`,
        ``,
        `/** The \`${model.name}\` union. Each constant keeps the wire string it encodes to. */`,
        `public enum ${model.name} {`,
        ...model.constants.map(
            (constant, index) => `    ${constant.name}("${stringLiteral(constant.wireValue)}")${index === model.constants.length - 1 ? ";" : ","}`,
        ),
        ``,
        `    private final String value;`,
        ``,
        `    ${model.name}(String value) {`,
        `        this.value = value;`,
        `    }`,
        ``,
        `    /** The wire string this constant encodes to. */`,
        `    public String toValue() {`,
        `        return this.value;`,
        `    }`,
        ``,
        `    /** The constant a wire string decodes to. */`,
        `    public static ${model.name} forValue(String value) {`,
        `        for (${model.name} candidate : values()) {`,
        `            if (candidate.value.equals(value)) {`,
        `                return candidate;`,
        `            }`,
        `        }`,
        ``,
        `        throw new IllegalArgumentException("${model.name}: unknown wire value " + value);`,
        `    }`,
        `}`,
        ``,
    ].join("\n");

/**
 * The readers and writers the generated Java models call.
 *
 * Its own file because Java allows one top-level class per file, and inlining these
 * would repeat them once per model. Package-private: an implementation detail of
 * `lunoraapi.models`, not part of the SDK surface.
 */

/**
 * The readers and writers the generated Java models can call, one per member.
 *
 * Kept as named blocks rather than one text so {@link javaHelperFile} can emit only
 * the members a document's models actually reference. A generated SDK carrying
 * readers for shapes its schema does not contain is dead code a consumer reads past.
 */
const JAVA_HELPER_MEMBERS: ReadonlyArray<{ lines: ReadonlyArray<string>; name: string }> = [
    {
        lines: [
            `    @SuppressWarnings("unchecked")`,
            `    static java.util.Map<String, Object> object(Object value) {`,
            `        return value instanceof java.util.Map`,
            `                ? (java.util.Map<String, Object>) value`,
            `                : new java.util.LinkedHashMap<String, Object>();`,
            `    }`,
        ],
        name: "object",
    },
    {
        lines: [`    static String text(Object value) {`, `        return value instanceof String ? (String) value : null;`, `    }`],
        name: "text",
    },
    {
        lines: [`    static Double number(Object value) {`, `        return value instanceof Number ? ((Number) value).doubleValue() : null;`, `    }`],
        name: "number",
    },
    {
        lines: [`    static Boolean flag(Object value) {`, `        return value instanceof Boolean ? (Boolean) value : null;`, `    }`],
        name: "flag",
    },
    {
        lines: [
            `    /** A nested model, or null when the payload carried no object there. */`,
            `    static <T> T readObject(Object value, java.util.function.Function<Object, T> read) {`,
            `        return value instanceof java.util.Map ? read.apply(value) : null;`,
            `    }`,
        ],
        name: "readObject",
    },
    {
        lines: [
            `    /** An enum constant, or null when the payload carried no string there. */`,
            `    static <T> T readEnum(Object value, java.util.function.Function<String, T> read) {`,
            `        return value instanceof String ? read.apply((String) value) : null;`,
            `    }`,
        ],
        name: "readEnum",
    },
    {
        lines: [
            `    static <T> java.util.List<T> readList(`,
            `            Object value, java.util.function.Function<Object, T> read) {`,
            `        if (!(value instanceof java.util.List)) {`,
            `            return null;`,
            `        }`,
            ``,
            `        java.util.List<T> items = new java.util.ArrayList<T>();`,
            ``,
            `        for (Object item : (java.util.List<?>) value) {`,
            `            items.add(read.apply(item));`,
            `        }`,
            ``,
            `        return items;`,
            `    }`,
        ],
        name: "readList",
    },
    {
        lines: [
            `    static <T> java.util.Map<String, T> readRecord(`,
            `            Object value, java.util.function.Function<Object, T> read) {`,
            `        if (!(value instanceof java.util.Map)) {`,
            `            return null;`,
            `        }`,
            ``,
            `        java.util.Map<String, T> entries = new java.util.LinkedHashMap<String, T>();`,
            ``,
            `        for (java.util.Map.Entry<?, ?> entry : ((java.util.Map<?, ?>) value).entrySet()) {`,
            `            entries.put(String.valueOf(entry.getKey()), read.apply(entry.getValue()));`,
            `        }`,
            ``,
            `        return entries;`,
            `    }`,
        ],
        name: "readRecord",
    },
    {
        lines: [
            `    static <T> java.util.List<Object> writeList(`,
            `            java.util.List<T> items, java.util.function.Function<T, Object> write) {`,
            `        if (items == null) {`,
            `            return null;`,
            `        }`,
            ``,
            `        java.util.List<Object> encoded = new java.util.ArrayList<Object>(items.size());`,
            ``,
            `        for (T item : items) {`,
            `            encoded.add(write.apply(item));`,
            `        }`,
            ``,
            `        return encoded;`,
            `    }`,
        ],
        name: "writeList",
    },
    {
        lines: [
            `    static <T> java.util.Map<String, Object> writeRecord(`,
            `            java.util.Map<String, T> entries, java.util.function.Function<T, Object> write) {`,
            `        if (entries == null) {`,
            `            return null;`,
            `        }`,
            ``,
            `        java.util.Map<String, Object> encoded = new java.util.LinkedHashMap<String, Object>();`,
            ``,
            `        for (java.util.Map.Entry<String, T> entry : entries.entrySet()) {`,
            `            encoded.put(entry.getKey(), write.apply(entry.getValue()));`,
            `        }`,
            ``,
            `        return encoded;`,
            `    }`,
        ],
        name: "writeRecord",
    },
];

/** `ModelWire.java`, carrying only the members `models` calls. */
const javaHelperFile = (models: string): string => {
    const used = JAVA_HELPER_MEMBERS.filter((member) => models.includes(`ModelWire.${member.name}(`));

    return [
        ...generatedBanner("java"),
        ``,
        `package ${MODEL_PACKAGE};`,
        ``,
        `/** Wire readers and writers shared by the generated models. */`,
        `final class ModelWire {`,
        `    private ModelWire() {}`,
        ...used.flatMap((member) => [``, ...member.lines]),
        `}`,
        ``,
    ].join("\n");
};

/**
 * Java models, ONE FILE PER CLASS.
 *
 * Not a style choice: a single file carrying every model is not compilable Java at
 * all — repeated `package` clauses and several public classes, which `javac`
 * rejects outright ("class, interface, enum or record expected"). quicktype's
 * single-file render has exactly that shape, and controlling emission is what makes
 * the problem go away rather than something to work around.
 */
const javaModelFiles = (document: OpenRpcDocument): Record<string, string> => {
    const declarations = jvmDeclarations(document);

    if (declarations.length === 0) {
        return {};
    }

    const files: Record<string, string> = {};

    for (const declaration of declarations) {
        files[`${MODEL_DIRECTORY}/${declaration.name}.java`] = declaration.kind === "enum" ? javaEnumFile(declaration) : javaClassFile(declaration);
    }

    return { [`${MODEL_DIRECTORY}/ModelWire.java`]: javaHelperFile(Object.values(files).join("\n")), ...files };
};

// ---------------------------------------------------------------------------
// Kotlin
// ---------------------------------------------------------------------------

const kotlinType = (type: JvmType): string => {
    switch (type.kind) {
        case "boolean": {
            return "Boolean";
        }
        case "class":
        case "enum": {
            return type.name;
        }
        case "list": {
            return `List<${kotlinType(type.item)}>`;
        }
        case "number": {
            return "Double";
        }
        case "record": {
            return `Map<String, ${kotlinType(type.value)}>`;
        }
        case "string": {
            return "String";
        }
        default: {
            return "WireValue";
        }
    }
};

/** A Kotlin expression turning the non-null `source` into a `WireValue`. */
const kotlinEncode = (type: JvmType, source: string, depth: number): string => {
    const item = `item${String(depth)}`;
    const entry = `entry${String(depth)}`;

    switch (type.kind) {
        case "boolean": {
            return `WireValue.Bool(${source})`;
        }
        case "class": {
            return `${source}.toWire()`;
        }
        case "enum": {
            return `WireValue.Text(${source}.wireValue)`;
        }
        case "list": {
            return `WireValue.Arr(${source}.map { ${item} -> ${kotlinEncode(type.item, item, depth + 1)} })`;
        }
        case "number": {
            return `WireValue.Num(${source})`;
        }
        case "record": {
            return `WireValue.Obj(${source}.map { ${entry} -> ${entry}.key to ${kotlinEncode(type.value, `${entry}.value`, depth + 1)} })`;
        }
        case "string": {
            return `WireValue.Text(${source})`;
        }
        default: {
            return source;
        }
    }
};

/**
 * A Kotlin expression reading `source` as a NON-null `type`.
 *
 * Used for a required property and for every element of a list or record, whose
 * declared element type is non-null: a payload that omits or mistypes one is a
 * contract violation, and failing loudly beats a collection holding a null the type
 * system says cannot be there. `label` names the offending position in the error —
 * the wire key, with `[]`/`{}` appended for an element of one.
 */
const kotlinRequired = (type: JvmType, source: string, depth: number, label: string): string =>
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- see above
    `wireNeed(${kotlinDecode(type, source, depth, label)}, "${kotlinLiteral(label)}")`;

/** A Kotlin expression reading `source` (a nullable `WireValue`) as a nullable `type`. */
const kotlinDecode = (type: JvmType, source: string, depth: number, label: string): string => {
    const item = `item${String(depth)}`;
    const entry = `entry${String(depth)}`;

    switch (type.kind) {
        case "boolean": {
            return `wireBool(${source})`;
        }
        case "class": {
            return `wireObj(${source})?.let { ${item} -> ${type.name}.fromWire(${item}) }`;
        }
        case "enum": {
            return `wireText(${source})?.let { ${item} -> ${type.name}.forValue(${item}) }`;
        }
        case "list": {
            return `wireArr(${source})?.items?.map { ${item} -> ${kotlinRequired(type.item, item, depth + 1, `${label}[]`)} }`;
        }
        case "number": {
            return `wireNum(${source})`;
        }
        case "record": {
            return `wireObj(${source})?.fields?.associate { ${entry} -> ${entry}.first to ${kotlinRequired(type.value, `${entry}.second`, depth + 1, `${label}{}`)} }`;
        }
        case "string": {
            return `wireText(${source})`;
        }
        default: {
            return source;
        }
    }
};

const kotlinClassDeclaration = (model: JvmClass): ReadonlyArray<string> => {
    const parameters = model.fields.map((field) => {
        const key = commentText(field.wireKey);
        const note = field.optional
            ? [
                  `    /**`,
                  `     * Wire key \`${key}\` — OPTIONAL: null omits the key entirely, because`,
                  `     * \`v.optional\` accepts the value or \`undefined\` and rejects an explicit null.`,
                  `     */`,
              ]
            : [`    /** Wire key \`${key}\`.${field.nullable ? " Nullable: null is sent as an explicit null." : ""} */`];

        return [...note, `    val ${field.name}: ${kotlinType(field.type)}${field.optional || field.nullable ? "?" : ""}${field.optional ? " = null" : ""},`];
    });

    const adds = model.fields.map((field) => {
        const key = kotlinLiteral(field.wireKey);

        if (field.optional) {
            return `                ${field.name}?.let { add("${key}" to ${kotlinEncode(field.type, "it", 0)}) }`;
        }

        if (field.nullable) {
            return `                add("${key}" to (${field.name}?.let { ${kotlinEncode(field.type, "it", 0)} } ?: WireValue.Null))`;
        }

        return `                add("${key}" to ${kotlinEncode(field.type, field.name, 0)})`;
    });

    const reads = model.fields.map((field) => {
        const source = `wireField(value, "${kotlinLiteral(field.wireKey)}")`;
        const read =
            field.optional || field.nullable ? kotlinDecode(field.type, source, 0, field.wireKey) : kotlinRequired(field.type, source, 0, field.wireKey);

        return `                ${field.name} = ${read},`;
    });

    return [
        `/**`,
        ` * The \`${model.name}\` model.`,
        ` *`,
        ` * Property names are local; the keys [toWire] and [fromWire] use are the schema's own,`,
        ` * emitted verbatim, so a renamed property cannot reach the wire.`,
        ` */`,
        `class ${model.name}(`,
        ...parameters.flat(),
        `) {`,
        `    /** This model as the wire-shaped object the transport encodes. */`,
        `    fun toWire(): WireValue =`,
        `        WireValue.Obj(`,
        `            buildList {`,
        ...adds,
        `            },`,
        `        )`,
        ``,
        `    companion object {`,
        `        /** Rebuild from a decoded wire value. */`,
        `        fun fromWire(value: WireValue): ${model.name} =`,
        `            ${model.name}(`,
        ...reads,
        `            )`,
        `    }`,
        `}`,
    ];
};

const kotlinEnumDeclaration = (model: JvmEnum): ReadonlyArray<string> => [
    `/** The \`${model.name}\` union. Each entry keeps the wire string it encodes to. */`,
    `enum class ${model.name}(val wireValue: String) {`,
    ...model.constants.map((constant) => `    ${constant.name}("${kotlinLiteral(constant.wireValue)}"),`),
    `    ;`,
    ``,
    `    companion object {`,
    `        /** The entry a wire string decodes to. */`,
    `        fun forValue(value: String): ${model.name} =`,
    `            entries.firstOrNull { it.wireValue == value }`,
    `                ?: throw IllegalArgumentException("${model.name}: unknown wire value " + value)`,
    `    }`,
    `}`,
];

/** The readers the generated Kotlin models call. File-private, since it is one file. */

/**
 * The file-private readers the generated Kotlin models can call, one per function.
 *
 * Filtered to what is used, because an unused private top-level function is a Kotlin
 * compiler warning — one a consumer sees, since `-nowarn` is only how the generated
 * check silences the rest of its own run.
 */
const KOTLIN_HELPERS: ReadonlyArray<{ lines: ReadonlyArray<string>; name: string }> = [
    {
        lines: [
            `private fun wireField(value: WireValue, key: String): WireValue? =`,
            `    (value as? WireValue.Obj)?.fields?.firstOrNull { it.first == key }?.second`,
        ],
        name: "wireField",
    },
    { lines: [`private fun wireText(value: WireValue?): String? = (value as? WireValue.Text)?.value`], name: "wireText" },
    { lines: [`private fun wireNum(value: WireValue?): Double? = (value as? WireValue.Num)?.value`], name: "wireNum" },
    { lines: [`private fun wireBool(value: WireValue?): Boolean? = (value as? WireValue.Bool)?.value`], name: "wireBool" },
    { lines: [`private fun wireArr(value: WireValue?): WireValue.Arr? = value as? WireValue.Arr`], name: "wireArr" },
    { lines: [`private fun wireObj(value: WireValue?): WireValue.Obj? = value as? WireValue.Obj`], name: "wireObj" },
    {
        lines: [
            `/** A required field the payload omitted or mistyped is a contract violation, not a null. */`,
            `private fun <T> wireNeed(read: T?, label: String): T =`,
            `    read ?: throw WireFormatException("lunora: the wire payload is missing or mistyped " + label)`,
        ],
        name: "wireNeed",
    },
];

/** Kotlin models: one file, because Kotlin allows many top-level declarations in one. */
const kotlinModelFiles = (document: OpenRpcDocument): Record<string, string> => {
    const declarations = jvmDeclarations(document);

    if (declarations.length === 0) {
        return {};
    }

    const body = declarations.flatMap((declaration) => [
        ...(declaration.kind === "enum" ? kotlinEnumDeclaration(declaration) : kotlinClassDeclaration(declaration)),
        ``,
    ]);

    const helpers = KOTLIN_HELPERS.filter((helper) => body.some((line) => line.includes(`${helper.name}(`)));
    const helperLines = helpers.flatMap((helper, index) => (index === 0 ? [...helper.lines] : [``, ...helper.lines]));

    const source = [
        ...generatedBanner("kotlin"),
        ``,
        `package ${MODEL_PACKAGE}`,
        ``,
        // `WireFormatException` rides with `wireNeed` and nothing else, so it is
        // imported only when there is a required field to fail on.
        ...(helpers.some((helper) => helper.name === "wireNeed") ? [`import dev.lunora.WireFormatException`] : []),
        `import dev.lunora.WireValue`,
        ``,
        ...body,
        ...helperLines,
        ``,
    ].join("\n");

    return { [`${MODEL_DIRECTORY}/Models.kt`]: source };
};

export { javaModelFiles, kotlinModelFiles, MODEL_PACKAGE };
