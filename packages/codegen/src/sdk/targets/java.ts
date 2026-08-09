/**
 * Java SDK target. Emits `Api.java` plus one file per generated model, against
 * the hand-written runtime in `sdks/java` (package `dev.lunora`).
 *
 * ## Why this target emits no typed models
 *
 * quicktype's JVM backends RENAME fields — a wire `channelId` becomes a Java
 * field `channelID` — and under `just-types` they emit no mapping metadata at
 * all. So a generated model cannot be projected back onto the wire: reflection
 * over its accessors yields `channelID`, which the server rejects, and
 * recovering the real name would mean replicating quicktype's renaming rules,
 * exactly the re-derivation this design forbids everywhere else.
 *
 * A typed model that silently sends wrong keys is worse than none, so the
 * surface takes wire-shaped arguments and no model file is written. Two things
 * would unlock typed arguments here: dropping `just-types` so the backend emits
 * `@JsonProperty` (which then requires Jackson at runtime), or extending
 * `SdkMethod` to carry the schema's property names so this target can emit an
 * explicit projection. Neither is speculative work to do before someone needs
 * typed JVM arguments.
 *
 * The compile check does not catch this class of bug — the generated code type
 * checks perfectly and throws at the first call — which is why it was found by
 * running an encode, not by building.
 */

import type { SdkMethod, SdkNamespace } from "../spec";
import { generatedHeaderLines, toPascalCase } from "../spec";
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
        `    /** ${method.summary} */`,
        `    public Object ${memberName(method.functionName)}(java.util.Map<String, Object> args, String shardKey) {`,
        `        return client.call(${verbConstant(method.verb)}, "${method.functionPath}", args, shardKey);`,
        `    }`,
    ].join("\n");

/**
 * A query's live-subscription method. Only queries get one — the WS `subscribe`
 * frame names a query the server re-runs on every write to the tables it read.
 */
const renderSubscribe = (method: SdkMethod): string =>
    [
        `    /** live ${method.summary} — re-runs on every write to the tables it reads. */`,
        `    public Runnable subscribe${toPascalCase(method.functionName)}(`,
        `            java.util.Map<String, Object> args,`,
        `            java.util.function.Consumer<Object> onData,`,
        `            java.util.function.Consumer<Client.SubscriptionError> onError) {`,
        `        return client.subscribe("${method.functionPath}", args, onData, onError);`,
        `    }`,
    ].join("\n");

const renderNamespaceClass = (namespace: SdkNamespace): string => {
    const typeName = `${toPascalCase(namespace.name)}Api`;

    const body = namespace.methods
        .map((method) => (method.verb === "query" ? `${renderCall(method)}\n\n${renderSubscribe(method)}` : renderCall(method)))
        .join("\n\n");

    return [
        `    /** Functions declared in \`${namespace.name}\`. */`,
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
    // Models are not emitted, so the backend choice only has to be valid.
    quicktype: { lang: "java", rendererOptions: { "just-types": "true", package: PACKAGE_NAME } },
    render,
    runtimePackage: ["dev.lunora:lunora (Maven Central)"],
};

export default javaTarget;

export { memberName };
