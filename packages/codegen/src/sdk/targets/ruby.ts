/**
 * Ruby SDK target. Emits `api.rb` plus `models.rb` beside a vendored copy of the
 * `sdks/ruby` transport.
 *
 * ## Layout
 *
 * ```
 * <out>/lunora.rb   the transport entry point, `require`s the three below
 * <out>/lunora/     client.rb, key.rb, wire.rb
 * <out>/api.rb      the generated surface
 * <out>/models.rb
 * ```
 *
 * Flat, with the transport's `lib/` prefix dropped. In the repo that prefix is
 * what makes `ruby -Ilib` work; in an output directory there is no `lib` for a
 * consumer to point `-I` at, and `require_relative "lunora"` from a file beside
 * it is the form that needs no load-path flag at all. `lunora.rb` still finds
 * `lunora/client.rb` because its own `require_relative`s are unchanged by the
 * move — both hop together.
 *
 * Unlike most targets, the MODELS carry a third-party dependency: quicktype's
 * Ruby backend renders `Dry::Struct` types and there is no renderer option that
 * avoids it (`strictness: none` and `just-types` both still emit
 * `require 'dry-types'`). The transport itself is dependency-free, so the gems
 * are needed only when a deployment declares typed schemas — which is why
 * `requires` is a list and why it says so.
 */

import type { SchemaPath, SdkMethod, SdkNamespace } from "../spec";
import { allMethods, argsChoice, commentText, generatedHeaderLines, stringLiteral, toPascalCase, toSnakeCase } from "../spec";
import type { SdkRenderInput, SdkTarget } from "../target";

const GENERATED_HEADER = `${generatedHeaderLines("ruby")
    .map((line) => `# ${line}`)
    .join("\n")}\n\n`;

/** Ruby keywords a function name could collide with. */
const RUBY_KEYWORDS = new Set([
    "alias",
    "and",
    "begin",
    "break",
    "case",
    "class",
    "def",
    "defined?",
    "do",
    "else",
    "elsif",
    "end",
    "ensure",
    "false",
    "for",
    "if",
    "in",
    "module",
    "next",
    "nil",
    "not",
    "or",
    "redo",
    "rescue",
    "retry",
    "return",
    "self",
    "super",
    "then",
    "true",
    "undef",
    "unless",
    "until",
    "when",
    "while",
    "yield",
]);

/**
 * Ruby interpolates `#{...}` inside a double-quoted string, so a function path
 * containing one would evaluate at load time rather than reach the wire.
 */
const rubyLiteral = (value: string): string => stringLiteral(value).replaceAll("#", "\u005C#");

/** `listMessages` → `list_messages`; a trailing `_` escapes a keyword. */
const memberName = (raw: string): string => {
    const snake = toSnakeCase(raw);

    return RUBY_KEYWORDS.has(snake) ? `${snake}_` : snake;
};

/**
 * The generated shim over `Lunora.wire_args`.
 *
 * quicktype's Ruby backend writes an UNSET optional as an explicit null, which
 * `v.optional(x)` rejects — so `to_dynamic` passed straight through fails
 * validation on every call that leaves one unset. Dropping every nil instead was
 * wrong the other way: a required `v.nullable()` has to reach the wire AS null,
 * and quicktype declares both `Types::X.optional`, so the model itself cannot
 * say which is which.
 *
 * So the projection takes the paths the SCHEMA says are optional, and lives in
 * the transport where it can be unit-tested (`sdks/ruby/test/test_wire_args.rb`)
 * rather than only through a generated SDK. See `ModelNullPaths` in `spec.ts`.
 */
const WIRE_ARGS_HELPER = `  # Delegates to the transport, which owns the projection and its tests — see
  # \`Lunora.wire_args\`. The path list is generated per model because only the
  # schema knows which nils may be dropped.
  def self.wire_args(model, optional_paths = [])
    Lunora.wire_args(model, optional_paths)
  end

`;

/** `[["limit"], ["rows", "*", "tag"]]` — the paths `wire_args` prunes at. */
const rubyPaths = (paths: ReadonlyArray<SchemaPath>): string =>
    `[${paths.map((path) => `[${path.map((segment) => `"${rubyLiteral(segment)}"`).join(", ")}]`).join(", ")}]`;

// A function whose args no model can express (a `v.bigint()`/`v.bytes()` schema, or
// a shape this backend could not name) still TAKES arguments — wire-shaped ones.
// Dropping the parameter made those functions uncallable with arguments, which is
// what the JVM targets already got right.
//
// `wire_args` calls `to_dynamic`, which only a generated model has, so an untyped
// argument is passed through — it is already the wire-shaped hash.
//
// The path list rides the call site because the model cannot carry it: quicktype
// declares an optional field and a required nullable one identically
// (`Types::X.optional`), so which nils may be dropped is knowable only from the
// schema. See `ModelNullPaths`.
const rubyPayload = (method: SdkMethod): string =>
    argsChoice(method, {
        none: "{}",
        typed: () => `LunoraApi.wire_args(args, ${rubyPaths(method.argsNullPaths.optional)})`,
        untyped: "args",
    });

/** One function as a method posting the RPC envelope. */
const renderCall = (method: SdkMethod): string => {
    const parameters = method.argsType === undefined && !method.takesArgs ? "shard_key: nil" : "args, shard_key: nil";
    const payload = rubyPayload(method);
    const call = `@client.${method.verb}("${rubyLiteral(method.functionPath)}", ${payload}, shard_key)`;
    // A typed result routes the decoded payload through the model's own
    // constructor; an untyped one is handed back as-is.
    const body = method.resultType === undefined ? call : `${method.resultType}.from_dynamic!(${call})`;

    return [`    # ${commentText(method.summary)}`, `    def ${memberName(method.functionName)}(${parameters})`, `      ${body}`, `    end`].join("\n");
};

/**
 * A query's live-subscription method. Only queries get one — the WS `subscribe`
 * frame names a query the server re-runs on every write to the tables it read.
 */
const renderSubscribe = (method: SdkMethod): string => {
    const parameters =
        method.argsType === undefined && !method.takesArgs ? "on_data, on_error = nil, shard_key: nil" : "args, on_data, on_error = nil, shard_key: nil";
    const payload = rubyPayload(method);

    return [
        `    # live ${commentText(method.summary)} — re-runs on every write to the tables it reads.`,
        `    def subscribe_${memberName(method.functionName)}(${parameters})`,
        `      @client.subscribe("${rubyLiteral(method.functionPath)}", ${payload}, on_data, on_error, shard_key)`,
        `    end`,
    ].join("\n");
};

const renderNamespaceClass = (namespace: SdkNamespace): string => {
    const body = namespace.methods
        .map((method) => (method.verb === "query" ? `${renderCall(method)}\n\n${renderSubscribe(method)}` : renderCall(method)))
        .join("\n\n");

    return [
        `  # Functions declared in \`${commentText(namespace.name)}\`.`,
        `  class ${toPascalCase(namespace.name)}Api`,
        `    def initialize(client)`,
        `      @client = client`,
        `    end`,
        ``,
        body,
        `  end`,
    ].join("\n");
};

const render = ({ models, namespaces }: SdkRenderInput): Record<string, string> => {
    const readers = namespaces.map((namespace) => `:${memberName(namespace.name)}`).join(", ");
    const assignments = namespaces.map((namespace) => `      @${memberName(namespace.name)} = ${toPascalCase(namespace.name)}Api.new(client)`).join("\n");

    const api = [
        `# frozen_string_literal: true\n\n`,
        GENERATED_HEADER,
        `require_relative "models"\n`,
        `\n`,
        `module LunoraApi\n`,
        // Only when something calls it: a deployment whose every function takes no
        // typed args would otherwise carry two unreferenced methods.
        allMethods(namespaces).some((method) => method.argsType !== undefined) ? WIRE_ARGS_HELPER : ``,
        namespaces.map((namespace) => renderNamespaceClass(namespace)).join("\n\n"),
        `\n\n`,
        `  # Typed entry point: \`Api.new(client).<namespace>.<function>(args)\`.\n`,
        `  class Api\n`,
        readers.length > 0 ? `    attr_reader ${readers}\n\n` : ``,
        `    def initialize(client)\n`,
        assignments.length > 0 ? `${assignments}\n` : `      @client = client\n`,
        `    end\n`,
        `  end\n`,
        `end\n`,
    ].join("");

    return {
        "api.rb": api,
        "models.rb":
            models.length > 0
                ? `# frozen_string_literal: true\n\n${GENERATED_HEADER}${models}\n`
                : `# frozen_string_literal: true\n\n${GENERATED_HEADER}# No typed argument or result schemas in this deployment.\n`,
    };
};

const rubyTarget: SdkTarget = {
    id: "ruby",
    // NOT `just-types`: that mode omits `to_dynamic`/`from_dynamic!`, which every
    // generated call site uses to reach the wire — so each one raised
    // NoMethodError. The default mode emits both.
    quicktype: { lang: "ruby", rendererOptions: {} },
    render,
    // The one target with a genuine install step, and it is quicktype's, not the
    // transport's.
    requires: ["dry-struct + dry-types (gems, required by the generated models)"],
    vendor: [
        { from: "lib/lunora.rb", to: "lunora.rb" },
        { from: "lib/lunora", to: "lunora" },
    ],
};

export { memberName, rubyTarget };
