/**
 * Java SDK target. Emits `Api.java` — and no model files — against the
 * hand-written runtime in `sdks/java` (package `dev.lunora`). The next section
 * is why there are no models, and holds the shared JVM reasoning that
 * `targets/kotlin.ts` points at.
 *
 * ## Why the JVM targets emit no typed models
 *
 * quicktype's JVM backends RENAME properties — a wire `channelId` becomes a
 * field `channelID` — and under `just-types` they emit no mapping metadata at
 * all. So a generated model cannot be projected back onto the wire: reflection
 * over its accessors yields `channelID`, which the server rejects, and
 * recovering the real name would mean replicating quicktype's renaming rules,
 * exactly the re-derivation this design forbids everywhere else. A typed model
 * that silently sends wrong keys is worse than none, so both surfaces take
 * wire-shaped arguments and no model file is written.
 *
 * The compile check does not catch this class of bug — the generated code type
 * checks perfectly and throws at the first call — which is why it was found by
 * running an encode, not by building. `generated_check/GeneratedSmoke.java`
 * exists for that, and asserts the wire key `channelId` specifically.
 *
 * ## What was measured, so nobody re-runs the investigation
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
 * **Java has a third problem, and it is the one with a fix.** The Java
 * backend's output through `quicktype()` is not compilable Java at all: it
 * concatenates one virtual file per class, so a single `Models.java` carries
 * repeated `package` and `import` clauses and multiple public classes (`javac`:
 * "class, interface, enum or record expected"). `quicktypeMultiFile`, which
 * quicktype-core exports, returns them keyed by filename and each file is
 * clean. That is worth knowing before anyone starts, but it is not the blocker.
 *
 * ## What would actually unlock this
 *
 * Not a renderer option — there isn't one. Either subclass the exported
 * `JavaRenderer`/`KotlinRenderer` so they emit a dependency-free `toWire()`
 * (their `annotationsForAccessor` hook already receives the `jsonName`, and
 * `ConvenienceRenderer.forEachClassProperty` yields name/`jsonName` pairs, so
 * the mapping would be quicktype's own rather than re-derived), or stop using
 * quicktype for the JVM models and emit them from the schema here. Both mean
 * writing a marshalling emitter for two languages against quicktype's
 * protected API or none of it — precisely the work the other five targets get
 * for free, and a large exception to `target.ts`'s contract that a target
 * contributes a backend name and renderer options. Worth doing when someone
 * needs typed JVM models; not before.
 */

import type { SdkMethod, SdkNamespace } from "../spec";
import { commentText, generatedHeaderLines, stringLiteral, toPascalCase } from "../spec";
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
 * One function as a method posting the RPC envelope.
 *
 * Arguments are a wire-shaped `Map` rather than a generated model — see the
 * file header for why the JVM backends cannot supply one that round-trips.
 */
const renderCall = (method: SdkMethod): string =>
    [
        `    /** ${commentText(method.summary)} */`,
        `    public Object ${memberName(method.functionName)}(java.util.Map<String, Object> args, String shardKey) {`,
        `        return client.call(${verbConstant(method.verb)}, "${stringLiteral(method.functionPath)}", args, shardKey);`,
        `    }`,
    ].join("\n");

/**
 * A query's live-subscription method. Only queries get one — the WS `subscribe`
 * frame names a query the server re-runs on every write to the tables it read.
 */
const renderSubscribe = (method: SdkMethod): string =>
    [
        `    /** live ${commentText(method.summary)} — re-runs on every write to the tables it reads. */`,
        `    public Runnable subscribe${toPascalCase(method.functionName)}(`,
        `            java.util.Map<String, Object> args,`,
        `            java.util.function.Consumer<Object> onData,`,
        `            java.util.function.Consumer<Client.SubscriptionError> onError,`,
        `            String shardKey) {`,
        `        return client.subscribe("${stringLiteral(method.functionPath)}", args, onData, onError, shardKey);`,
        `    }`,
    ].join("\n");

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

    const api = [
        GENERATED_HEADER,
        `package ${PACKAGE_NAME};\n`,
        `\n`,
        `import dev.lunora.Client;\n`,
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

    return { "Api.java": api };
};

const javaTarget: SdkTarget = {
    id: "java",
    render,
    runtimePackage: ["dev.lunora:lunora (Maven Central)"],
};

export { javaTarget, memberName };
