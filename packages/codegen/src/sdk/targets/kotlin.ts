/**
 * Kotlin SDK target. Emits `lunoraapi/Api.kt` and `lunoraapi/models/Models.kt`
 * beside a vendored copy of the `sdks/kotlin` transport.
 *
 * ## Layout
 *
 * ```
 * <out>/dev/lunora/*.kt            the vendored transport, package dev.lunora
 * <out>/lunoraapi/Api.kt           the generated surface, package lunoraapi
 * <out>/lunoraapi/models/Models.kt the generated models, package lunoraapi.models
 * ```
 *
 * Kotlin resolves by package declaration, not by directory, so `kotlinc <out>`
 * compiles both regardless of the layout. The directories mirror the packages
 * anyway — matching the Java target, and satisfying ktlint's filename rule — and
 * the transport gains the `dev/lunora/` prefix it does not have in the repo,
 * where its sources sit flat under `src/`.
 *
 * ```
 * kotlinc <out> YourCode.kt -include-runtime -d app.jar
 * ```
 *
 * No build file is emitted, for the same reason as Java: there is no single one,
 * and none is needed — the transport hand-rolls `Json.kt` precisely so the JVM's
 * missing JSON costs no dependency.
 *
 * ## Why the models come from the schema and not from quicktype
 *
 * The same reason as the Java target, which carries the measurements for both:
 * quicktype's JVM backends RENAME properties — a wire `channelId` becomes
 * `channelID` — and under `just-types` they emit no mapping metadata, so a model
 * they render cannot be projected back onto the wire. So this target sets no
 * `quicktype` backend and implements `renderModels` instead; the JSON Schema's
 * property names ARE the wire names, which is what makes that sound. See
 * {@link file://../jvm-models.ts}.
 *
 * Kotlin was the harder of the two, and the extra reason is worth keeping here
 * rather than only in `targets/java.ts`: under `just-types` that backend also
 * erases enum wire values. A `v.union(v.literal("text"), v.literal("image"))`
 * renders as `enum class Kind { Image, Text }` with the strings `"text"` and
 * `"image"` nowhere in the output, so even a perfect property-name projection could
 * not have encoded the committed fixture's own `kind` argument. Java's `just-types`
 * enum keeps `toValue()`/`forValue()`; restoring the mapping for Kotlin meant
 * picking a `framework` (`jackson`, `klaxon`, `kotlinx`), each of which drags a
 * third-party library into a transport that hand-rolls `Json.kt` precisely to avoid
 * one. The emitted enum carries the value itself — `enum class Kind(val wireValue:
 * String)` — so nothing is lost and nothing is installed.
 */

import { kotlinModelFiles, MODEL_PACKAGE } from "../jvm-models";
import type { SdkMethod, SdkNamespace } from "../spec";
import { commentText, generatedHeaderLines, kotlinLiteral, referencedModels, toPascalCase } from "../spec";
import type { SdkRenderInput, SdkTarget } from "../target";

const GENERATED_HEADER = `${generatedHeaderLines("kotlin")
    .map((line) => `// ${line}`)
    .join("\n")}\n\n`;

/** The package generated code lives in. */
const PACKAGE_NAME = "lunoraapi";

/** Kotlin hard keywords; a soft keyword is legal as an identifier. */
const KOTLIN_KEYWORDS = new Set([
    "as",
    "break",
    "class",
    "continue",
    "do",
    "else",
    "false",
    "for",
    "fun",
    "if",
    "in",
    "interface",
    "is",
    "null",
    "object",
    "package",
    "return",
    "super",
    "this",
    "throw",
    "true",
    "try",
    "typealias",
    "typeof",
    "val",
    "var",
    "when",
    "while",
]);

/** `list_messages` → `listMessages`; a keyword takes Kotlin's backtick form. */
const memberName = (raw: string): string => {
    const pascal = toPascalCase(raw);
    const camel = pascal.charAt(0).toLowerCase() + pascal.slice(1);

    return KOTLIN_KEYWORDS.has(camel) ? `\`${camel}\`` : camel;
};

/** The runtime verb entry for a method's kind. */
const verbConstant = (verb: string): string => `Verb.${verb.toUpperCase()}`;

/**
 * The `args` parameter, and the expression that puts it on the wire.
 *
 * A declared model is taken by value and projected through its own `toWire()`. A
 * schema with no model — no declared shape, or a `v.bigint()`/`v.bytes()` that no
 * generated field can carry — keeps the transport's own `WireValue`, which is the
 * untyped escape hatch the CLI's `unrepresentable` warning tells the caller to use.
 */
const argsParameter = (method: SdkMethod): { declaration: string; payload: string } =>
    method.argsType === undefined
        ? { declaration: "args: WireValue? = null", payload: "args" }
        : { declaration: `args: ${method.argsType}`, payload: "args.toWire()" };

/** One function as a method posting the RPC envelope. */
const renderCall = (method: SdkMethod): string => {
    const args = argsParameter(method);
    const call = `client.call(${verbConstant(method.verb)}, "${kotlinLiteral(method.functionPath)}", ${args.payload}, shardKey)`;

    return [
        `    /** ${commentText(method.summary)} */`,
        `    fun ${memberName(method.functionName)}(${args.declaration}, shardKey: String? = null): ${method.resultType ?? "WireValue"} =`,
        // A typed result is re-read through the model's own reader; an untyped one
        // is handed back as the decoded wire value.
        `        ${method.resultType === undefined ? call : `${method.resultType}.fromWire(${call})`}`,
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
        `    fun subscribe${toPascalCase(method.functionName)}(`,
        `        ${args.declaration},`,
        `        onData: ((WireValue) -> Unit)?,`,
        `        onError: ((SubscriptionError) -> Unit)? = null,`,
        `        shardKey: String? = null,`,
        `    ): () -> Unit =`,
        `        client.subscribe("${kotlinLiteral(method.functionPath)}", ${args.payload}, onData, onError, shardKey)`,
    ].join("\n");
};

const renderNamespaceClass = (namespace: SdkNamespace): string => {
    const typeName = `${toPascalCase(namespace.name)}Api`;

    const body = namespace.methods
        .map((method) => (method.verb === "query" ? `${renderCall(method)}\n\n${renderSubscribe(method)}` : renderCall(method)))
        .join("\n\n");

    return [`/** Functions declared in \`${commentText(namespace.name)}\`. */`, `class ${typeName}(private val client: Client) {`, body, `}`].join("\n");
};

const render = ({ namespaces }: SdkRenderInput): Record<string, string> => {
    const properties = namespaces
        .map((namespace) => `    val ${memberName(namespace.name)}: ${toPascalCase(namespace.name)}Api = ${toPascalCase(namespace.name)}Api(client)`)
        .join("\n");

    const methods = namespaces.flatMap((namespace) => namespace.methods);

    // Conditional so the file carries no unused import, which is a ktlint offence
    // and a compiler warning: `SubscriptionError` appears only where a query does,
    // and `WireValue` only where a method's args or result went untyped.
    const imports = [
        `import dev.lunora.Client\n`,
        ...(methods.some((method) => method.verb === "query") ? [`import dev.lunora.SubscriptionError\n`] : []),
        `import dev.lunora.Verb\n`,
        ...(methods.some((method) => method.argsType === undefined || method.resultType === undefined) ? [`import dev.lunora.WireValue\n`] : []),
        // Only the models the surface references. `withDeclaredModels` has already
        // cleared any name the emitter did not declare, so every import resolves.
        ...referencedModels(namespaces).map((name) => `import ${MODEL_PACKAGE}.${name}\n`),
    ];

    const api = [
        GENERATED_HEADER,
        `package ${PACKAGE_NAME}\n`,
        `\n`,
        ...imports,
        `\n`,
        namespaces.map((namespace) => renderNamespaceClass(namespace)).join("\n\n"),
        `\n\n`,
        `/** Typed entry point: \`Api(client).<namespace>.<function>(args)\`. */\n`,
        `class Api(client: Client) {\n`,
        properties.length > 0 ? `${properties}\n` : `    init { require(true) { client } }\n`,
        `}\n`,
    ].join("");

    return { [`${PACKAGE_NAME}/Api.kt`]: api };
};

const kotlinTarget: SdkTarget = {
    id: "kotlin",
    render,
    renderModels: kotlinModelFiles,
    // Nothing: the transport is JDK-only and the models are plain classes with a
    // hand-written `toWire()`.
    requires: [],
    vendor: [{ from: "src", to: "dev/lunora" }],
};

export { kotlinTarget, memberName };
