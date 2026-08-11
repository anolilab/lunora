/**
 * Rust SDK target. Emits a `lunora-api` crate beside a vendored copy of the
 * `sdks/rust` transport crate.
 *
 * ## Layout
 *
 * ```
 * <out>/Cargo.toml          crate lunora-api, depends on lunora by path
 * <out>/src/lib.rs          pub mod api; pub mod models;
 * <out>/src/{api,models}.rs the generated surface
 * <out>/lunora/             the vendored transport crate, verbatim
 * ```
 *
 * A path dependency, so `use lunora::client::Client` in the generated code is an
 * ordinary extern-crate import and needs no rewriting. A consumer adds one line:
 *
 * ```
 * lunora-api = { path = "sdk/rust" }
 * ```
 *
 * `[workspace]` is emitted (empty) on the outer crate on purpose. Without it, a
 * consumer whose project is a Cargo workspace pulls this directory in as a member
 * and then fails with "current package believes it's in a workspace when it's
 * not" the moment anything builds it directly. Declaring it its OWN workspace
 * root insulates it, and the nested `lunora` path dependency becomes a member of
 * that inner workspace rather than of the consumer's.
 *
 * The transport's `serde_json` is not a manual install: it is declared in the
 * vendored `lunora/Cargo.toml` and cargo resolves it like any other dependency.
 * What a consumer must be told is that the generated MODELS need `serde` with
 * `derive` — the outer crate declares that too, but a consumer moving these files
 * elsewhere has to keep it.
 *
 * A generated model is a `serde` type, so it reaches the wire via
 * `serde_json::to_value` and `lunora::from_model_json` — a structural mapping rather
 * than a lossy round-trip, which is safe because the generator refuses to emit
 * a typed model for any schema carrying a `v.bigint()` or `v.bytes()` (the only
 * values a plain JSON projection could not represent).
 */

import type { SdkMethod, SdkNamespace } from "../spec";
import { argsChoice, commentText, generatedHeaderLines, stringLiteral, toPascalCase, toSnakeCase } from "../spec";
import type { SdkRenderInput, SdkTarget } from "../target";

const GENERATED_HEADER = `${generatedHeaderLines("rust")
    .map((line) => `// ${line}`)
    .join("\n")}\n\n`;

/** The crate root, declaring the two generated modules. */
const CRATE_ROOT = `${GENERATED_HEADER}pub mod api;\npub mod models;\n`;

/**
 * The generated crate's manifest. `edition` and the `serde_json` major match the
 * vendored transport's own manifest, so the two crates cannot disagree about the
 * JSON types they pass across the boundary.
 */
const CARGO_MANIFEST = `# The generated Lunora Rust SDK, with the transport vendored under ./lunora.
#
# Add to a consuming crate:
#
#     lunora-api = { path = "sdk/rust" }

[package]
name = "lunora-api"
version = "0.1.0"
edition = "2021"
publish = false

# Its own workspace root, so a consumer whose project IS a workspace does not
# adopt this directory as a member (which then fails to build on its own).
[workspace]

[dependencies]
lunora = { path = "lunora" }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
`;

/** Rust keywords (including reserved ones) a function name could collide with. */
const RUST_KEYWORDS = new Set([
    "abstract",
    "as",
    "async",
    "await",
    "become",
    "box",
    "break",
    "const",
    "continue",
    "crate",
    "do",
    "dyn",
    "else",
    "enum",
    "extern",
    "false",
    "final",
    "fn",
    "for",
    "if",
    "impl",
    "in",
    "let",
    "loop",
    "macro",
    "match",
    "mod",
    "move",
    "mut",
    "override",
    "priv",
    "pub",
    "ref",
    "return",
    "self",
    "static",
    "struct",
    "super",
    "trait",
    "true",
    "try",
    "type",
    "typeof",
    "unsafe",
    "unsized",
    "use",
    "virtual",
    "where",
    "while",
    "yield",
]);

/** `listMessages` → `list_messages`; a keyword takes Rust's `r#` raw form. */
const memberName = (raw: string): string => {
    const snake = toSnakeCase(raw);

    return RUST_KEYWORDS.has(snake) ? `r#${snake}` : snake;
};

/** The runtime verb constant for a method's kind. */
const verbConstant = (verb: string): string => `Verb::${toPascalCase(verb)}`;

/** One function as a method posting the RPC envelope. */
const renderCall = (method: SdkMethod): string => {
    // A function whose args no model can express (a `v.bigint()`/`v.bytes()` schema, or
    // a shape this backend could not name) still TAKES arguments — wire-shaped ones.
    // Dropping the parameter made those functions uncallable with arguments, which is
    // what the JVM targets already got right.
    const parameters = argsChoice(method, {
        none: "&self, shard_key: Option<&str>",
        typed: (type) => `&self, args: &${type}, shard_key: Option<&str>`,
        untyped: "&self, args: &WireValue, shard_key: Option<&str>",
    });
    const payload = argsChoice(method, {
        none: "&WireValue::Object(Vec::new())",
        typed: () => "&from_model_json(&serde_json::to_value(args).map_err(|error| ClientError::Transport(error.to_string()))?)",
        untyped: "args",
    });
    const call = `self.client.call(${verbConstant(method.verb)}, "${stringLiteral(method.functionPath)}", ${payload}, shard_key)`;

    // A typed result is deserialised into the model; an untyped one is handed
    // back as the raw wire value.
    if (method.resultType === undefined) {
        return [
            `    /// ${commentText(method.summary)}`,
            `    pub fn ${memberName(method.functionName)}(${parameters}) -> Result<WireValue, ClientError> {`,
            `        ${call}`,
            `    }`,
        ].join("\n");
    }

    return [
        `    /// ${commentText(method.summary)}`,
        `    pub fn ${memberName(method.functionName)}(${parameters}) -> Result<${method.resultType}, ClientError> {`,
        `        let raw = ${call}?;`,
        `        let json = encode_wire(&raw).map_err(ClientError::Wire)?;`,
        `        serde_json::from_value(json).map_err(|error| ClientError::Transport(error.to_string()))`,
        `    }`,
    ].join("\n");
};

/**
 * A query's live-subscription method. Only queries get one — the WS `subscribe`
 * frame names a query the server re-runs on every write to the tables it read.
 */
const renderSubscribe = (method: SdkMethod): string => {
    const argument = argsChoice(method, { none: "", typed: (type) => `args: &${type}, `, untyped: "args: &WireValue, " });
    const payload = argsChoice(method, {
        none: "WireValue::Object(Vec::new())",
        typed: () => "from_model_json(&serde_json::to_value(args).map_err(|error| ClientError::Transport(error.to_string()))?)",
        untyped: "args.clone()",
    });

    return [
        `    /// live ${commentText(method.summary)} — re-runs on every write to the tables it reads.`,
        `    pub fn subscribe_${memberName(method.functionName)}(`,
        `        &mut self,`,
        // The crate's own aliases rather than the boxed closure spelt out: they
        // carry a `Send` bound (without which `Client` is not `Send` and cannot be
        // shared at all), and a hand-written copy here would not follow it.
        `        ${argument}on_data: DataHandler,`,
        `        on_error: ErrorHandler,`,
        `        shard_key: Option<&str>,`,
        `    ) -> Result<String, ClientError> {`,
        `        let _ = shard_key;`,
        `        Ok(self.client.subscribe("${stringLiteral(method.functionPath)}", ${payload}, on_data, on_error))`,
        `    }`,
    ].join("\n");
};

const renderNamespaceStruct = (namespace: SdkNamespace): string => {
    const typeName = `${toPascalCase(namespace.name)}Api`;

    const body = namespace.methods
        .map((method) => (method.verb === "query" ? `${renderCall(method)}\n\n${renderSubscribe(method)}` : renderCall(method)))
        .join("\n\n");

    return [
        `/// Functions declared in \`${commentText(namespace.name)}\`.`,
        `pub struct ${typeName}<'client> {`,
        `    client: &'client mut Client,`,
        `}`,
        ``,
        `impl<'client> ${typeName}<'client> {`,
        body,
        `}`,
    ].join("\n");
};

const render = ({ models, namespaces }: SdkRenderInput): Record<string, string> => {
    const accessors = namespaces
        .map((namespace) =>
            [
                `    /// Functions declared in \`${commentText(namespace.name)}\`.`,
                `    pub fn ${memberName(namespace.name)}(&mut self) -> ${toPascalCase(namespace.name)}Api<'_> {`,
                `        ${toPascalCase(namespace.name)}Api { client: self.client }`,
                `    }`,
            ].join("\n"),
        )
        .join("\n\n");

    const api = [
        GENERATED_HEADER,
        `#![allow(dead_code, unused_imports)]\n`,
        `\n`,
        `use lunora::client::{Client, ClientError, DataHandler, ErrorHandler, Verb};\n`,
        `use lunora::wire::{encode_wire, from_model_json, WireValue};\n`,
        `\n`,
        `use crate::models::*;\n`,
        `\n`,
        namespaces.map((namespace) => renderNamespaceStruct(namespace)).join("\n\n"),
        `\n\n`,
        `/// Typed entry point: \`Api::new(&client).<namespace>().<function>(args)\`.\n`,
        `pub struct Api<'client> {\n`,
        `    client: &'client mut Client,\n`,
        `}\n`,
        `\n`,
        `impl<'client> Api<'client> {\n`,
        `    pub fn new(client: &'client mut Client) -> Self {\n`,
        `        Self { client }\n`,
        `    }\n`,
        accessors.length > 0 ? `\n${accessors}\n` : ``,
        `}\n`,
    ].join("");

    return {
        "Cargo.toml": CARGO_MANIFEST,
        "src/api.rs": api,
        "src/lib.rs": CRATE_ROOT,
        "src/models.rs":
            models.length > 0
                ? `${GENERATED_HEADER}#![allow(dead_code)]\n\n${models}\n`
                : `${GENERATED_HEADER}#![allow(dead_code)]\n\n// No typed argument or result schemas in this deployment.\n`,
    };
};

const rustTarget: SdkTarget = {
    id: "rust",
    quicktype: { lang: "rust", rendererOptions: { "just-types": "true" } },
    render,
    // Resolved by cargo from the manifests emitted and vendored here, so there is
    // no manual step — but named, because they are genuinely third-party and a
    // consumer relocating these files carries them along.
    requires: ["serde (derive) + serde_json — declared in the emitted Cargo.toml, fetched by cargo"],
    vendor: [
        { from: "Cargo.toml", to: "lunora/Cargo.toml" },
        { from: "src", to: "lunora/src" },
    ],
};

export { memberName, rustTarget };
