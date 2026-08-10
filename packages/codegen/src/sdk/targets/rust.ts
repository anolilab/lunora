/**
 * Rust SDK target. Emits `api.rs` plus `models.rs` against the hand-written
 * runtime in `sdks/rust` (crate `lunora`).
 *
 * A generated model is a `serde` type, so it reaches the wire via
 * `serde_json::to_value` and `lunora::from_json` — a structural mapping rather
 * than a lossy round-trip, which is safe because the generator refuses to emit
 * a typed model for any schema carrying a `v.bigint()` or `v.bytes()` (the only
 * values a plain JSON projection could not represent).
 */

import type { SdkMethod, SdkNamespace } from "../spec";
import { commentText, generatedHeaderLines, stringLiteral, toPascalCase, toSnakeCase } from "../spec";
import type { SdkRenderInput, SdkTarget } from "../target";

const GENERATED_HEADER = `${generatedHeaderLines("rust")
    .map((line) => `// ${line}`)
    .join("\n")}\n\n`;

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
    const parameters = method.argsType === undefined ? "&self, shard_key: Option<&str>" : `&self, args: &${method.argsType}, shard_key: Option<&str>`;
    const payload =
        method.argsType === undefined
            ? "&WireValue::Object(Vec::new())"
            : "&from_json(&serde_json::to_value(args).map_err(|error| ClientError::Transport(error.to_string()))?)";
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
    const argument = method.argsType === undefined ? "" : `args: &${method.argsType}, `;
    const payload =
        method.argsType === undefined
            ? "WireValue::Object(Vec::new())"
            : "from_json(&serde_json::to_value(args).map_err(|error| ClientError::Transport(error.to_string()))?)";

    return [
        `    /// live ${commentText(method.summary)} — re-runs on every write to the tables it reads.`,
        `    pub fn subscribe_${memberName(method.functionName)}(`,
        `        &mut self,`,
        `        ${argument}on_data: Option<Box<dyn Fn(&WireValue)>>,`,
        `        on_error: Option<Box<dyn Fn(&SubscriptionError)>>,`,
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
        `use lunora::client::{Client, ClientError, SubscriptionError, Verb};\n`,
        `use lunora::wire::{encode_wire, from_json, WireValue};\n`,
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
        "api.rs": api,
        "models.rs":
            models.length > 0
                ? `${GENERATED_HEADER}#![allow(dead_code)]\n\n${models}\n`
                : `${GENERATED_HEADER}#![allow(dead_code)]\n\n// No typed argument or result schemas in this deployment.\n`,
    };
};

const rustTarget: SdkTarget = {
    id: "rust",
    quicktype: { lang: "rust", rendererOptions: { "just-types": "true" } },
    render,
    runtimePackage: ["lunora (crates.io)", "serde + serde_json (required by the generated models)"],
};

export { memberName, rustTarget };
