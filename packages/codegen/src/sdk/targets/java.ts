/**
 * Java SDK target. Emits `lunoraapi/Api.java` plus one model file per class under
 * `lunoraapi/models/`, beside a vendored copy of the `sdks/java` transport. The
 * section after the layout is why those models are emitted here rather than by
 * quicktype, and holds the shared JVM reasoning that `targets/kotlin.ts` points at.
 *
 * ## Layout
 *
 * ```
 * <out>/dev/lunora/*.java         the vendored transport, package dev.lunora
 * <out>/lunoraapi/Api.java        the generated surface, package lunoraapi
 * <out>/lunoraapi/models/*.java   the generated models, package lunoraapi.models
 * ```
 *
 * Package-per-directory under one root, because that is what `javac` searches:
 * point it at `<out>` as a source root and `import dev.lunora.Client;` in the
 * generated file resolves with nothing on the classpath.
 *
 * ```
 * javac -sourcepath <out> -d classes YourCode.java
 * ```
 *
 * No build file is emitted. Java has no single one to emit — Maven and Gradle
 * would each need their own, and neither is required: nothing here has a
 * dependency (Java SE ships no JSON, so `Json.java` is hand-rolled, and the models
 * are plain classes), so a source root is complete. Consumers on a build tool add
 * `<out>` as an extra source directory.
 *
 * ## Why the JVM models are emitted from the schema, not by quicktype
 *
 * quicktype's JVM backends RENAME properties — a wire `channelId` becomes a field
 * `channelID` — and under `just-types` they emit no mapping metadata at all. So a
 * model they render cannot be projected back onto the wire: reflection over its
 * accessors yields `channelID`, which the server rejects, and recovering the real
 * name would mean replicating quicktype's renaming rules, exactly the
 * re-derivation this design forbids everywhere else.
 *
 * So neither JVM target sets `quicktype`. Both implement `renderModels` instead and
 * emit from the JSON Schema, whose property names ARE the wire names — see
 * {@link file://../jvm-models.ts} for the mapping. There is no renamer to fight
 * there: `toWire()`/`fromWire()` write the schema's own key as a string literal,
 * and the derived field identifier never reaches the wire.
 *
 * The compile check does not catch the class of bug this replaced — the generated
 * code type checks perfectly and throws at the first call — which is why it was
 * found by running an encode, not by building. `sdks/smoke/java/GeneratedSmoke.java`
 * exists for that, and asserts the wire key `channelId` specifically.
 *
 * ## What was measured about quicktype, so nobody re-runs the investigation
 *
 * Against quicktype-core 26.0.0 (`dist/language/{Java,Kotlin}/language.d.ts`
 * is the exhaustive option list — the CLI's `--help` is not).
 *
 * **Java options:** `array-type`, `just-types`, `datetime-provider`,
 * `acronym-style`, `package`, `lombok`, `lombok-copy-annotations`.
 * **Kotlin options:** `just-types`, `framework` (`jackson` | `klaxon` |
 * `kotlinx`, defaulting to `jackson`), `acronym-style`, `package`.
 *
 * **`acronym-style` governs exactly the `Id` → `ID` step, and is still not
 * enough.** `splitIntoWords("channelId")` flags `Id` as an acronym, and the
 * default `pascal` maps it through `allUpperWordStyle` — that is where `ID`
 * comes from. `acronym-style: original` does yield a field named `channelId`
 * on both backends. But the acronym rule is only one of several renamers: of 14
 * realistic wire keys, 5 still come out renamed under `original` — `2fa` →
 * `the2Fa`, `ID` → `id`, `URLs` → `urLs`, `some-key` → `someKey`, `user_name`
 * → `userName`. Property names come from a user's `v.object({ … })` keys, so
 * all of those are reachable. `camel` and `lowerCase` are worse (`channelId`
 * survives `camel` but `htmlURL` → `htmlUrl`, and `lowerCase` gives
 * `channelid`). No `acronym-style` value emits mapping metadata, so a
 * name-matching projection would also have to be *verified* per property
 * against generated source, per language — and would then silently degrade
 * most real schemas to untyped.
 *
 * **`lombok` adds `@lombok.Data` and changes nothing about names or mapping**,
 * and is itself a dependency. `array-type` only picks `List` vs `[]`;
 * `datetime-provider` only affects date-shaped types, which
 * `hasUnrepresentableWireType` already keeps out of the models.
 *
 * **Dropping `just-types` does emit the exact wire name — at the cost of a
 * dependency.** Java without it annotates both accessors
 * (`@JsonProperty("channelId")`), and each Kotlin framework carries it too
 * (`@get:JsonProperty("channelId")`, `@Json(name = "channelId")`,
 * `@SerialName("channelId")`). Every one of the four needs a third-party
 * library on the classpath at compile *and* run time — jackson-databind +
 * jackson-annotations, jackson-module-kotlin, klaxon, or
 * kotlinx-serialization plus its compiler plugin. That is the one thing these
 * transports are defined not to have: the JVM ships no JSON at all, which is
 * why `Json.java` and `Json.kt` are hand-rolled.
 *
 * **Kotlin has a second, irreducible blocker: `just-types` erases enum wire
 * values.** A `v.union(v.literal("text"), v.literal("image"))` renders as
 * `enum class Kind { Image, Text }` — the strings `"text"` and `"image"` appear
 * nowhere in the output — so no projection, however careful, could encode the
 * committed fixture's own `kind` argument. Java's `just-types` enum keeps
 * `toValue()`/`forValue()` and does not have this problem. Only a `framework`
 * (a dependency) restores the mapping for Kotlin.
 *
 * **A third Java problem, now avoided rather than solved.** The Java backend's
 * output through `quicktype()` is not compilable Java at all: it concatenates one
 * virtual file per class, so a single `Models.java` carries repeated `package` and
 * `import` clauses and multiple public classes (`javac`: "class, interface, enum or
 * record expected"). `jvm-models.ts` emits one file per class, so the shape that
 * fails never arises.
 *
 * ## What was done instead
 *
 * Emit the models from the JSON Schema (`jvm-models.ts`), which is the second of
 * the two options this comment used to leave open. The first — subclassing the
 * exported `JavaRenderer`/`KotlinRenderer` so they emit a dependency-free
 * `toWire()` — was not taken: it buys quicktype's own `jsonName` mapping at the
 * cost of building against its protected API for two languages, and the schema
 * already carries the wire names outright. `renderModels` on {@link SdkTarget} is
 * the seam, so this stays a two-target exception rather than a change to how the
 * other five are rendered.
 */

import { javaModelFiles, MODEL_PACKAGE } from "../jvm-models";
import type { SdkMethod, SdkNamespace } from "../spec";
import { commentText, generatedHeaderLines, referencedModels, stringLiteral, toPascalCase } from "../spec";
import type { SdkRenderInput, SdkTarget } from "../target";

const GENERATED_HEADER = `${generatedHeaderLines("java")
    .map((line) => `// ${line}`)
    .join("\n")}\n\n`;

/** The package generated code lives in. */
const PACKAGE_NAME = "lunoraapi";

/** Java keywords a function name could collide with. */
const JAVA_KEYWORDS = new Set([
    "abstract",
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
    "final",
    "finally",
    "float",
    "for",
    "goto",
    "if",
    "implements",
    "import",
    "instanceof",
    "int",
    "interface",
    "long",
    "native",
    "new",
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
    "transient",
    "try",
    "void",
    "volatile",
    "while",
]);

/** `list_messages` → `listMessages`; a keyword gets a trailing `_`. */
const memberName = (raw: string): string => {
    const pascal = toPascalCase(raw);
    const camel = pascal.charAt(0).toLowerCase() + pascal.slice(1);

    return JAVA_KEYWORDS.has(camel) ? `${camel}_` : camel;
};

/** The runtime verb constant for a method's kind. */
const verbConstant = (verb: string): string => `Client.Verb.${verb.toUpperCase()}`;

/**
 * The `args` parameter's type, and the expression that puts it on the wire.
 *
 * A declared model is taken by value and projected through its own `toWire()`. A
 * schema with no model — no declared shape, or a `v.bigint()`/`v.bytes()` that no
 * generated field can carry — keeps the wire-shaped `Map`, which is the untyped
 * escape hatch the CLI's `unrepresentable` warning tells the caller to use.
 */
const argsParameter = (method: SdkMethod): { payload: string; type: string } =>
    method.argsType === undefined
        ? { payload: "args", type: "java.util.Map<String, Object>" }
        : { payload: "args == null ? null : args.toWire()", type: method.argsType };

/** One function as a method posting the RPC envelope. */
const renderCall = (method: SdkMethod): string => {
    const args = argsParameter(method);
    const call = `client.call(\n                ${verbConstant(method.verb)}, "${stringLiteral(method.functionPath)}", ${args.payload}, shardKey)`;

    return [
        `    /** ${commentText(method.summary)} */`,
        `    public ${method.resultType ?? "Object"} ${memberName(method.functionName)}(${args.type} args, String shardKey) {`,
        // A typed result is re-read through the model's own reader; an untyped one
        // is handed back as the decoded wire value.
        `        return ${method.resultType === undefined ? call : `${method.resultType}.fromWire(${call})`};`,
        `    }`,
    ].join("\n");
};

/**
 * A query's live-subscription method. Only queries get one — the WS `subscribe`
 * frame names a query the server re-runs on every write to the tables it read.
 */
const renderSubscribe = (method: SdkMethod): string => {
    const args = argsParameter(method);

    return [
        `    /** live ${commentText(method.summary)} — re-runs on every write to the tables it reads. */`,
        `    public Runnable subscribe${toPascalCase(method.functionName)}(`,
        `            ${args.type} args,`,
        `            java.util.function.Consumer<Object> onData,`,
        `            java.util.function.Consumer<Client.SubscriptionError> onError,`,
        `            String shardKey) {`,
        `        return client.subscribe(`,
        `                "${stringLiteral(method.functionPath)}", ${args.payload}, onData, onError, shardKey);`,
        `    }`,
    ].join("\n");
};

const renderNamespaceClass = (namespace: SdkNamespace): string => {
    const typeName = `${toPascalCase(namespace.name)}Api`;

    const body = namespace.methods
        .map((method) => (method.verb === "query" ? `${renderCall(method)}\n\n${renderSubscribe(method)}` : renderCall(method)))
        .join("\n\n");

    return [
        `    /** Functions declared in \`${commentText(namespace.name)}\`. */`,
        `    public static final class ${typeName} {`,
        `        private final Client client;`,
        ``,
        `        ${typeName}(Client client) {`,
        `            this.client = client;`,
        `        }`,
        ``,
        body.replaceAll(/^ {4}/gmu, "        "),
        `    }`,
    ].join("\n");
};

const render = ({ namespaces }: SdkRenderInput): Record<string, string> => {
    const fields = namespaces.map((namespace) => `    public final ${toPascalCase(namespace.name)}Api ${memberName(namespace.name)};`).join("\n");
    const assignments = namespaces
        .map((namespace) => `        this.${memberName(namespace.name)} = new ${toPascalCase(namespace.name)}Api(client);`)
        .join("\n");

    // Only the models the surface actually references. `withDeclaredModels` has
    // already cleared any name the emitter did not declare, so every import here
    // resolves — an unused or dangling one would fail `javac -Xlint:all`.
    const modelImports = referencedModels(namespaces).map((name) => `import ${MODEL_PACKAGE}.${name};\n`);

    const api = [
        GENERATED_HEADER,
        `package ${PACKAGE_NAME};\n`,
        `\n`,
        `import dev.lunora.Client;\n`,
        ...modelImports,
        `\n`,
        `/** Typed entry point: \`new Api(client).<namespace>.<function>(args, shardKey)\`. */\n`,
        `public final class Api {\n`,
        fields.length > 0 ? `${fields}\n\n` : ``,
        `    public Api(Client client) {\n`,
        assignments.length > 0 ? `${assignments}\n` : `        // No functions in this deployment.\n`,
        `    }\n`,
        `\n`,
        namespaces.map((namespace) => renderNamespaceClass(namespace)).join("\n\n"),
        `\n}\n`,
    ].join("");

    return { [`${PACKAGE_NAME}/Api.java`]: api };
};

const javaTarget: SdkTarget = {
    id: "java",
    render,
    renderModels: javaModelFiles,
    // Nothing: the transport is `java.util`, `java.net` and `java.math`, and the
    // models are plain classes with a hand-written `toWire()`.
    requires: [],
    // `test/` is not copied: it asserts against `protocol/fixtures/`, which is not
    // part of the output, so it could not run in a consumer's tree.
    vendor: [{ from: "src/dev/lunora", to: "dev/lunora" }],
};

export { javaTarget, memberName };
