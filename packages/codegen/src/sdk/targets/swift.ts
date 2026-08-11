/**
 * Swift SDK target. Emits a SwiftPM package whose `LunoraApi` target is the
 * generated surface and whose `Lunora` target is a vendored copy of the
 * `sdks/swift` transport.
 *
 * ## Layout
 *
 * ```
 * <out>/Package.swift            two targets, LunoraApi depending on Lunora
 * <out>/Sources/Lunora/          the vendored transport (Foundation only)
 * <out>/Sources/LunoraApi/       Api.swift, Models.swift
 * ```
 *
 * Two targets rather than one, because `import Lunora` in the generated code is a
 * MODULE import: folding both into one target would make that line refer to the
 * module it is already inside, which does not compile. SwiftPM resolves a
 * target-to-target dependency inside one package with no registry involved, so
 * the copy is self-contained. A consumer adds `.package(path: "sdk/swift")` and
 * `.product(name: "LunoraApi", package: "swift")`.
 *
 * That second `"swift"` is the output DIRECTORY's name, and it is unavoidable.
 * SwiftPM identifies a local path dependency by its last path component, ignoring
 * the manifest's `name:` — `package: "LunoraSdk"` fails with "unknown package
 * 'LunoraSdk' … valid packages are: 'sdk'". Nor does a bare product name in a
 * target's `dependencies` resolve: SwiftPM answers "product 'LunoraApi' … not
 * found. Did you mean `.product(name: "sdk_LunoraApi", package: "sdk")`?". Both
 * measured, both against a real generated package. So the emitted manifest says
 * out loud that the identity is the directory name, rather than printing an
 * example that only works for one `--out` value.
 *
 * `Package.swift` is emitted rather than vendored: the repo's own manifest also
 * declares the conformance and sample targets, whose sources are deliberately not
 * copied — a manifest naming a directory that is absent is a hard SwiftPM error,
 * so shipping it would make every generated package fail to load.
 *
 * Unlike the other targets, this one does NOT pass `just-types` to quicktype:
 * without it the Swift backend omits `Codable`, and `Codable` is how a
 * generated model reaches the wire — `LunoraClient.wireValue` projects it
 * through `JSONEncoder`.
 */

import type { SdkMethod, SdkNamespace } from "../spec";
import { argsChoice, commentText, generatedHeaderLines, stringLiteral, toPascalCase } from "../spec";
import type { SdkRenderInput, SdkTarget } from "../target";

const GENERATED_HEADER = `${generatedHeaderLines("swift")
    .map((line) => `// ${line}`)
    .join("\n")}\n\n`;

/** Where the generated target's sources live, as SwiftPM's convention requires. */
const SURFACE_TARGET_DIRECTORY = "Sources/LunoraApi";

/**
 * The emitted package manifest. `platforms` matches the transport's own manifest
 * — the vendored sources are that package's, so a lower floor here would fail on
 * whatever API they use.
 */
const PACKAGE_MANIFEST = `// swift-tools-version:5.9

import PackageDescription

// The generated Lunora Swift SDK, with the transport vendored under
// Sources/Lunora. Add to a consuming package — where "swift" below is the NAME OF
// THE DIRECTORY THIS FILE IS IN, which is how SwiftPM identifies a local path
// dependency. It ignores the "name:" field for that, and a bare product name in a
// target's dependencies does not resolve at all, so the directory name is the one
// spelling that works:
//
//     dependencies: [.package(path: "sdk/swift")],
//     targets: [
//         .target(
//             name: "YourTarget",
//             dependencies: [.product(name: "LunoraApi", package: "swift")]
//         )
//     ]
let package = Package(
    name: "LunoraSdk",
    platforms: [.macOS(.v12), .iOS(.v15)],
    products: [
        .library(name: "LunoraApi", targets: ["LunoraApi"]),
        .library(name: "Lunora", targets: ["Lunora"]),
    ],
    targets: [
        .target(name: "Lunora"),
        .target(name: "LunoraApi", dependencies: ["Lunora"]),
    ]
)
`;

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

// `wireValue` projects a Codable model; an untyped argument is already a wire
// value and is passed through.
const swiftPayload = (method: SdkMethod): string => argsChoice(method, { none: "nil", typed: () => "try LunoraClient.wireValue(args)", untyped: "args" });

/** One function as a method posting the RPC envelope. */
const renderCall = (method: SdkMethod): string => {
    // A function whose args no model can express (a `v.bigint()`/`v.bytes()` schema, or
    // a shape this backend could not name) still TAKES arguments — wire-shaped ones.
    // Dropping the parameter made those functions uncallable with arguments, which is
    // what the JVM targets already got right.
    const parameters = argsChoice(method, {
        none: "shardKey: String? = nil",
        typed: (type) => `_ args: ${type}, shardKey: String? = nil`,
        untyped: "_ args: Any, shardKey: String? = nil",
    });
    const payload = swiftPayload(method);
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
    const argument = argsChoice(method, { none: "", typed: (type) => `_ args: ${type}, `, untyped: "_ args: Any, " });
    const payload = swiftPayload(method);

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
        "Package.swift": PACKAGE_MANIFEST,
        [`${SURFACE_TARGET_DIRECTORY}/Api.swift`]: api,
        [`${SURFACE_TARGET_DIRECTORY}/Models.swift`]:
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
    // Nothing: the transport is Foundation only.
    requires: [],
    vendor: [{ from: "Sources/Lunora", to: "Sources/Lunora" }],
};

export { memberName, swiftTarget };
