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
import { generatedHeaderLines, toPascalCase, toSnakeCase } from "../spec";
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

    return [
        `    /// ${method.summary}`,
        `    pub fn ${memberName(method.functionName)}(${parameters}) -> Result<WireValue, ClientError> {`,
        `        self.client.call(${verbConstant(method.verb)}, "${method.functionPath}", ${payload}, shard_key)`,
        `    }`,
    ].join("\n");
};

const renderNamespaceStruct = (namespace: SdkNamespace): string => {
    const typeName = `${toPascalCase(namespace.name)}Api`;

    return [
        `/// Functions declared in \`${namespace.name}\`.`,
        `pub struct ${typeName}<'client> {`,
        `    client: &'client Client,`,
        `}`,
        ``,
        `impl<'client> ${typeName}<'client> {`,
        namespace.methods.map((method) => renderCall(method)).join("\n\n"),
        `}`,
    ].join("\n");
};

const render = ({ models, namespaces }: SdkRenderInput): Record<string, string> => {
    const accessors = namespaces
        .map((namespace) =>
            [
                `    /// Functions declared in \`${namespace.name}\`.`,
                `    pub fn ${memberName(namespace.name)}(&self) -> ${toPascalCase(namespace.name)}Api<'_> {`,
                `        ${toPascalCase(namespace.name)}Api { client: self.client }`,
                `    }`,
            ].join("\n"),
        )
        .join("\n\n");

    const api = [
        GENERATED_HEADER,
        `#![allow(dead_code, unused_imports)]\n`,
        `\n`,
        `use lunora::client::{Client, ClientError, Verb};\n`,
        `use lunora::wire::{from_json, WireValue};\n`,
        `\n`,
        `use crate::models::*;\n`,
        `\n`,
        namespaces.map((namespace) => renderNamespaceStruct(namespace)).join("\n\n"),
        `\n\n`,
        `/// Typed entry point: \`Api::new(&client).<namespace>().<function>(args)\`.\n`,
        `pub struct Api<'client> {\n`,
        `    client: &'client Client,\n`,
        `}\n`,
        `\n`,
        `impl<'client> Api<'client> {\n`,
        `    pub fn new(client: &'client Client) -> Self {\n`,
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

export default rustTarget;

export { memberName };
