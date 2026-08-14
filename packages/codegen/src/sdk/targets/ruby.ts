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

import type { SdkMethod, SdkNamespace } from "../spec";
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
 * Projects a model onto the wire, dropping nil-valued fields at every depth.
 *
 * quicktype's Ruby backend writes an UNSET optional as an explicit null, while
 * `v.optional(x)` parses `undefined`-or-`x` and rejects null — so passing
 * `to_dynamic` straight through fails validation on the server for every call
 * that leaves an optional field unset. The Python backend omits the key itself;
 * this makes Ruby agree with it.
 *
 * The ceiling, and it is a real gap rather than a shrug: a REQUIRED
 * `v.nullable()` field the caller means to send AS null is dropped too, and the
 * server rejects the absent key. There is nothing in the rendered model to tell
 * the two apart — quicktype declares both `Types::X.optional`.
 *
 * Not, as this comment used to claim, a limitation Python's `to_dict` shares: it
 * writes `if self.x is not None:` for an optional field and `result["x"] = …`
 * unconditionally for a required one, so it gets both right. `sdks/README.md`
 * carries the per-port table.
 */
const WIRE_ARGS_HELPER = `  def self.wire_args(model)
    drop_nils(model.to_dynamic)
  end

  def self.drop_nils(value)
    case value
    when ::Hash then value.each_with_object({}) { |(key, item), out| out[key] = drop_nils(item) unless item.nil? }
    when ::Array then value.map { |item| drop_nils(item) }
    else value
    end
  end

`;

// A function whose args no model can express (a `v.bigint()`/`v.bytes()` schema, or
// a shape this backend could not name) still TAKES arguments — wire-shaped ones.
// Dropping the parameter made those functions uncallable with arguments, which is
// what the JVM targets already got right.
//
// `wire_args` calls `to_dynamic`, which only a generated model has, so an untyped
// argument is passed through — it is already the wire-shaped hash.
const rubyPayload = (method: SdkMethod): string => argsChoice(method, { none: "{}", typed: () => "LunoraApi.wire_args(args)", untyped: "args" });

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
