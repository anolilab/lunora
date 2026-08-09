/**
 * Java SDK target. Emits `Api.java` plus one file per generated model, against
 * the hand-written runtime in `sdks/java` (package `dev.lunora`).
 *
 * The per-model files are not a style choice: Java permits one public class per
 * source file, and quicktype's Java backend concatenates every class into a
 * single stream delimited by `// Name.java` markers. Emitting that verbatim
 * produces a file that cannot compile, so the marker is what this target splits
 * on.
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

/** One function as a method posting the RPC envelope. */
const renderCall = (method: SdkMethod): string => {
    const parameters = method.argsType === undefined ? "String shardKey" : `${method.argsType} args, String shardKey`;
    const payload = method.argsType === undefined ? "null" : "args";

    return [
        `    /** ${method.summary} */`,
        `    public Object ${memberName(method.functionName)}(${parameters}) {`,
        `        return client.call(${verbConstant(method.verb)}, "${method.functionPath}", ${payload}, shardKey);`,
        `    }`,
    ].join("\n");
};

/**
 * A query's live-subscription method. Only queries get one — the WS `subscribe`
 * frame names a query the server re-runs on every write to the tables it read.
 */
const renderSubscribe = (method: SdkMethod): string => {
    const argument = method.argsType === undefined ? "" : `${method.argsType} args, `;
    const payload = method.argsType === undefined ? "null" : "args";

    return [
        `    /** live ${method.summary} — re-runs on every write to the tables it reads. */`,
        `    public Runnable subscribe${toPascalCase(method.functionName)}(`,
        `            ${argument}java.util.function.Consumer<Object> onData, java.util.function.Consumer<Client.SubscriptionError> onError) {`,
        `        return client.subscribe("${method.functionPath}", ${payload}, onData, onError);`,
        `    }`,
    ].join("\n");
};

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

/**
 * Split quicktype's concatenated Java stream on its `// Name.java` markers.
 *
 * Returns an empty map when the stream carries no marker, which is how a
 * deployment with no typed schemas arrives.
 */
const splitJavaFiles = (models: string): Record<string, string> => {
    const files: Record<string, string> = {};
    const pattern = /^\/\/ (\w+\.java)$/gmu;
    const markers = [...models.matchAll(pattern)];

    for (const [index, marker] of markers.entries()) {
        const name = marker[1];

        if (name === undefined) {
            continue;
        }

        const start = marker.index + marker[0].length;
        const next = markers[index + 1];
        const end = next === undefined ? models.length : next.index;

        files[name] = `${GENERATED_HEADER}${models.slice(start, end).trim()}\n`;
    }

    return files;
};

const render = ({ models, namespaces }: SdkRenderInput): Record<string, string> => {
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

    return { "Api.java": api, ...splitJavaFiles(models) };
};

const javaTarget: SdkTarget = {
    id: "java",
    quicktype: { lang: "java", rendererOptions: { "just-types": "true", package: PACKAGE_NAME } },
    render,
    runtimePackage: ["dev.lunora:lunora (Maven Central)"],
};

export default javaTarget;

export { memberName, splitJavaFiles };
