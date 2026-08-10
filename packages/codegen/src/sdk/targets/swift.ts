/**
 * Swift SDK target. Emits `Api.swift` plus `Models.swift` against the
 * hand-written runtime in `sdks/swift` (SwiftPM package `Lunora`).
 *
 * Unlike the other targets, this one does NOT pass `just-types` to quicktype:
 * without it the Swift backend omits `Codable`, and `Codable` is how a
 * generated model reaches the wire — `LunoraClient.wireValue` projects it
 * through `JSONEncoder`.
 */

import type { SdkMethod, SdkNamespace } from "../spec";
import { commentText, generatedHeaderLines, stringLiteral, toPascalCase } from "../spec";
import type { SdkRenderInput, SdkTarget } from "../target";

const GENERATED_HEADER = `${generatedHeaderLines("swift")
    .map((line) => `// ${line}`)
    .join("\n")}\n\n`;

/** Swift keywords a function name could collide with, escaped with backticks. */
const SWIFT_KEYWORDS = new Set([
    "as",
    "associatedtype",
    "borrowing",
    "break",
    "case",
    "catch",
    "class",
    "consuming",
    "continue",
    "default",
    "defer",
    "deinit",
    "do",
    "else",
    "enum",
    "extension",
    "fallthrough",
    "false",
    "fileprivate",
    "for",
    "func",
    "guard",
    "if",
    "import",
    "in",
    "init",
    "inout",
    "internal",
    "is",
    "let",
    "nil",
    "nonisolated",
    "open",
    "operator",
    "precedencegroup",
    "private",
    "protocol",
    "public",
    "repeat",
    "rethrows",
    "return",
    "self",
    "static",
    "struct",
    "subscript",
    "super",
    "switch",
    "throw",
    "throws",
    "true",
    "try",
    "typealias",
    "var",
    "where",
    "while",
]);

/** `list_messages` → `listMessages`; a keyword is escaped with backticks. */
const memberName = (raw: string): string => {
    const pascal = toPascalCase(raw);
    const camel = pascal.charAt(0).toLowerCase() + pascal.slice(1);

    return SWIFT_KEYWORDS.has(camel) ? `\`${camel}\`` : camel;
};

/** One function as a method posting the RPC envelope. */
const renderCall = (method: SdkMethod): string => {
    const parameters = method.argsType === undefined ? "shardKey: String? = nil" : `_ args: ${method.argsType}, shardKey: String? = nil`;
    const payload = method.argsType === undefined ? "nil" : "try LunoraClient.wireValue(args)";
    const returns = method.resultType ?? "Any";
    const call = `try client.${method.verb}("${stringLiteral(method.functionPath)}", args: ${payload}, shardKey: shardKey)`;
    // A typed result is re-decoded into the model; an untyped one is handed back.
    const body =
        method.resultType === undefined
            ? `return ${call}`
            : [
                  `let raw = ${call}`,
                  // `.fragmentsAllowed`, because a result schema of `v.string()`
                  // renders as a typealias to a scalar — and without the option
                  // `data(withJSONObject:)` throws on any top-level non-container.
                  `        let data = try JSONSerialization.data(withJSONObject: raw, options: [.fragmentsAllowed])`,
                  `        return try JSONDecoder().decode(${method.resultType}.self, from: data)`,
              ].join("\n");

    return [
        `    /// ${commentText(method.summary)}`,
        `    public func ${memberName(method.functionName)}(${parameters}) throws -> ${returns} {`,
        `        ${body}`,
        `    }`,
    ].join("\n");
};

/**
 * A query's live-subscription method. Only queries get one — the WS `subscribe`
 * frame names a query the server re-runs on every write to the tables it read.
 */
const renderSubscribe = (method: SdkMethod): string => {
    const argument = method.argsType === undefined ? "" : `_ args: ${method.argsType}, `;
    const payload = method.argsType === undefined ? "nil" : "try LunoraClient.wireValue(args)";

    return [
        `    /// live ${commentText(method.summary)} — re-runs on every write to the tables it reads.`,
        `    @discardableResult`,
        `    public func subscribe${toPascalCase(method.functionName)}(`,
        `        ${argument}onData: ((Any) -> Void)?,`,
        `        onError: ((LunoraSubscriptionError) -> Void)? = nil,`,
        `        shardKey: String? = nil`,
        `    ) throws -> LunoraUnsubscribe {`,
        `        client.subscribe("${stringLiteral(method.functionPath)}", args: ${payload}, onData: onData, onError: onError, shardKey: shardKey)`,
        `    }`,
    ].join("\n");
};

const renderNamespaceStruct = (namespace: SdkNamespace): string => {
    const typeName = `${toPascalCase(namespace.name)}API`;

    const body = namespace.methods
        .map((method) => (method.verb === "query" ? `${renderCall(method)}\n\n${renderSubscribe(method)}` : renderCall(method)))
        .join("\n\n");

    return [`/// Functions declared in \`${commentText(namespace.name)}\`.`, `public struct ${typeName} {`, `    let client: LunoraClient`, ``, body, `}`].join(
        "\n",
    );
};

const render = ({ models, namespaces }: SdkRenderInput): Record<string, string> => {
    const properties = namespaces.map((namespace) => `    public let ${memberName(namespace.name)}: ${toPascalCase(namespace.name)}API`).join("\n");
    const assignments = namespaces.map((namespace) => `        ${memberName(namespace.name)} = ${toPascalCase(namespace.name)}API(client: client)`).join("\n");

    const api = [
        GENERATED_HEADER,
        `import Foundation\n`,
        `import Lunora\n`,
        `\n`,
        namespaces.map((namespace) => renderNamespaceStruct(namespace)).join("\n\n"),
        `\n\n`,
        `/// Typed entry point: \`API(client:).<namespace>.<function>(args)\`.\n`,
        `public struct API {\n`,
        properties.length > 0 ? `${properties}\n\n` : ``,
        `    public init(client: LunoraClient) {\n`,
        assignments.length > 0 ? `${assignments}\n` : `        _ = client\n`,
        `    }\n`,
        `}\n`,
    ].join("");

    return {
        "Api.swift": api,
        "Models.swift":
            models.length > 0
                ? `${GENERATED_HEADER}${models}\n`
                : `${GENERATED_HEADER}import Foundation\n\n// No typed argument or result schemas in this deployment.\n`,
    };
};

const swiftTarget: SdkTarget = {
    id: "swift",
    // No `just-types`: without Codable a generated model cannot reach the wire.
    // `access-level: public` because Swift refuses a public method whose
    // parameter is an internal type — the generated surface is public, so the
    // models it names must be too.
    quicktype: { lang: "swift", rendererOptions: { "access-level": "public" } },
    render,
    runtimePackage: ["Lunora (SwiftPM)"],
};

export { memberName, swiftTarget };
