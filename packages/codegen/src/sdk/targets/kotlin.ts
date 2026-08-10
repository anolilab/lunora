/**
 * Kotlin SDK target. Emits `Api.kt` against the hand-written runtime in
 * `sdks/kotlin` (package `dev.lunora`).
 *
 * ## Why this target emits no typed models
 *
 * The same reason as the Java target, which carries the measurements for both:
 * quicktype's JVM backends RENAME properties — a wire `channelId` becomes
 * `channelID` — and under `just-types` they emit no mapping metadata, so a
 * generated model cannot be projected back onto the wire. A typed model that
 * silently sends wrong keys is worse than none, so the surface takes
 * wire-shaped arguments.
 *
 * Kotlin is the harder of the two, and the extra reason is worth stating here
 * rather than only in `targets/java.ts`: under `just-types` this backend also
 * erases enum wire values. A `v.union(v.literal("text"), v.literal("image"))`
 * renders as `enum class Kind { Image, Text }` with the strings `"text"` and
 * `"image"` nowhere in the output, so even a perfect property-name projection
 * could not encode the committed fixture's own `kind` argument. Java's
 * `just-types` enum keeps `toValue()`/`forValue()`. Restoring the mapping means
 * picking a `framework` (`jackson`, `klaxon`, `kotlinx`), each of which drags a
 * third-party library into a transport that hand-rolls `Json.kt` precisely to
 * avoid one.
 */

import type { SdkMethod, SdkNamespace } from "../spec";
import { commentText, generatedHeaderLines, stringLiteral, toPascalCase } from "../spec";
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
 * Escape a value for a Kotlin `"…"` literal.
 *
 * Kotlin interpolates `$`, and `$` is a legal JavaScript identifier character,
 * so an export named `$client` produced `"billing:$client"` — which compiles,
 * runs, and posts the client object's `toString()` as the wire path. Ruby needs
 * the same treatment for `#{`; see `rubyLiteral`.
 */
// The Kotlin escape for a literal dollar, assembled from parts so the sequence
// never appears as a template-looking literal in this file.
const DOLLAR_ESCAPE = ["\u0024", "{", "'", "\u0024", "'", "}"].join("");

// Layered ON TOP of `stringLiteral` rather than repeating its rules: escaping
// backslashes in both would emit a literal that decodes to two of them. The
// dollar pass runs last, so the escape it inserts is not itself re-escaped.
const kotlinLiteral = (value: string): string => stringLiteral(value).split("\u0024").join(DOLLAR_ESCAPE);

/** One function as a method posting the RPC envelope. */
const renderCall = (method: SdkMethod): string =>
    [
        `    /** ${commentText(method.summary)} */`,
        `    fun ${memberName(method.functionName)}(args: WireValue? = null, shardKey: String? = null): WireValue =`,
        `        client.call(${verbConstant(method.verb)}, "${kotlinLiteral(method.functionPath)}", args, shardKey)`,
    ].join("\n");

/**
 * A query's live-subscription method. Only queries get one — the WS `subscribe`
 * frame names a query the server re-runs on every write to the tables it read.
 */
const renderSubscribe = (method: SdkMethod): string =>
    [
        `    /** live ${commentText(method.summary)} — re-runs on every write to the tables it reads. */`,
        `    fun subscribe${toPascalCase(method.functionName)}(`,
        `        args: WireValue? = null,`,
        `        onData: ((WireValue) -> Unit)?,`,
        `        onError: ((SubscriptionError) -> Unit)? = null,`,
        `        shardKey: String? = null,`,
        `    ): () -> Unit = client.subscribe("${kotlinLiteral(method.functionPath)}", args, onData, onError, shardKey)`,
    ].join("\n");

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

    const api = [
        GENERATED_HEADER,
        `package ${PACKAGE_NAME}\n`,
        `\n`,
        `import dev.lunora.Client\n`,
        `import dev.lunora.SubscriptionError\n`,
        `import dev.lunora.Verb\n`,
        `import dev.lunora.WireValue\n`,
        `\n`,
        namespaces.map((namespace) => renderNamespaceClass(namespace)).join("\n\n"),
        `\n\n`,
        `/** Typed entry point: \`Api(client).<namespace>.<function>(args)\`. */\n`,
        `class Api(client: Client) {\n`,
        properties.length > 0 ? `${properties}\n` : `    init { require(true) { client } }\n`,
        `}\n`,
    ].join("");

    return { "Api.kt": api };
};

const kotlinTarget: SdkTarget = {
    id: "kotlin",
    render,
    runtimePackage: ["dev.lunora:lunora (Maven Central)"],
};

export { kotlinTarget, memberName };
