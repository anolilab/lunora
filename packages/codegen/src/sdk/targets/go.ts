/**
 * Go SDK target. Emits `lunoraapi/{api,models}.go` plus a `go.mod`, beside a
 * vendored copy of the `sdks/go` transport.
 *
 * Typed results go through `lunora.Call[T]`, a free function, because Go methods
 * cannot take type parameters — that is what lets a generated method declare a
 * concrete return type while the decode stays generic.
 *
 * ## Layout
 *
 * ```
 * <out>/go.mod        module lunorasdk
 * <out>/lunora/       the vendored transport, package lunora
 * <out>/lunoraapi/    the generated surface, package lunoraapi
 * ```
 *
 * The generated import used to be `github.com/anolilab/lunora-go/lunora`, which
 * does not exist; it now names the emitted module, so the copy resolves with no
 * network. A consumer wires it in with two lines:
 *
 * ```
 * require lunorasdk v0.0.0
 * replace lunorasdk => ./sdk/go
 * ```
 *
 * ## Why a module and not one flat package
 *
 * Folding the transport and the surface into a single package would need no
 * import path at all, which is tempting. It also puts quicktype's model names in
 * the same scope as the transport's exports — and the transport exports `Error`,
 * `Map`, `Set`, `Date`, `URL`, `Bytes` and `Client`. A table called `error` or a
 * result model called `Map` would then be a redeclaration, i.e. a schema in a
 * user's project breaking the SDK's own compile. Two packages cost the `replace`
 * line and cannot collide.
 *
 * The module path is `lunorasdk` — no dot, so Go can never mistake it for a
 * fetchable path and go looking for a proxy that would 404. With `replace` it
 * never resolves remotely at all.
 */

import type { SdkMethod, SdkNamespace } from "../spec";
import { commentText, generatedHeaderLines, stringLiteral, toPascalCase } from "../spec";
import type { SdkRenderInput, SdkTarget } from "../target";

const GENERATED_HEADER = `${generatedHeaderLines("go")
    .map((line) => `// ${line}`)
    .join("\n")}\n\n`;

/** The package generated code lives in, and the directory it is written to. */
const PACKAGE_NAME = "lunoraapi";

/** The module the emitted `go.mod` declares, and that a consumer `replace`s. */
const MODULE_PATH = "lunorasdk";

/** The runtime package the generated code imports, inside the emitted module. */
const RUNTIME_IMPORT = `${MODULE_PATH}/lunora`;

/**
 * The `go` directive of the emitted module. Matches `sdks/go/go.mod`, since the
 * vendored transport is that module's source and a lower value here would fail
 * on whatever language version it uses.
 */
const GO_DIRECTIVE = "1.22";

/**
 * Go has no reserved-word collision problem for our names: every generated
 * method is exported, so it is PascalCase, and no Go keyword is capitalised.
 * `Type`/`Func` are identifiers, not keywords.
 */
const memberName = (raw: string): string => toPascalCase(raw);

/** One function as an exported method posting the RPC envelope. */
const renderCall = (namespaceType: string, method: SdkMethod): string => {
    const argument = method.argsType === undefined ? "" : `args ${method.argsType}, `;
    const payload = method.argsType === undefined ? "nil" : "args";
    const returns = method.resultType ?? "any";
    // The verb crosses into the runtime as a typed constant, not a string: a
    // typo here would otherwise compile and route a read over the write path.
    const verb = `lunora.Verb${method.verb.charAt(0).toUpperCase()}${method.verb.slice(1)}`;
    const call = `lunora.Call[${returns}](a.client, ${verb}, "${stringLiteral(method.functionPath)}", ${payload}, shardKey)`;

    return [
        `// ${memberName(method.functionName)} invokes ${commentText(method.summary)}.`,
        `func (a *${namespaceType}) ${memberName(method.functionName)}(${argument}shardKey string) (${returns}, error) {`,
        `\treturn ${call}`,
        `}`,
    ].join("\n");
};

/**
 * A query's live-subscription method. Only queries get one — the WS `subscribe`
 * frame names a query the server re-runs on every write to the tables it read.
 */
const renderSubscribe = (namespaceType: string, method: SdkMethod): string => {
    const argument = method.argsType === undefined ? "" : `args ${method.argsType}, `;
    const payload = method.argsType === undefined ? "nil" : "args";
    const name = `Subscribe${memberName(method.functionName)}`;

    return [
        `// ${name} opens a live ${commentText(method.functionPath)}; it re-runs on every write to the tables it reads.`,
        `func (a *${namespaceType}) ${name}(${argument}onData lunora.DataHandler, onError lunora.ErrorHandler, shardKey string) lunora.Unsubscribe {`,
        `\treturn a.client.Subscribe("${stringLiteral(method.functionPath)}", ${payload}, onData, onError, shardKey)`,
        `}`,
    ].join("\n");
};

const renderNamespace = (namespace: SdkNamespace): string => {
    const namespaceType = `${toPascalCase(namespace.name)}API`;

    const body = namespace.methods
        .map((method) =>
            method.verb === "query" ? `${renderCall(namespaceType, method)}\n\n${renderSubscribe(namespaceType, method)}` : renderCall(namespaceType, method),
        )
        .join("\n\n");

    return [
        `// ${namespaceType} groups the functions declared in ${commentText(namespace.name)}.`,
        `type ${namespaceType} struct{ client *lunora.Client }`,
        ``,
        body,
    ].join("\n");
};

const render = ({ models, namespaces }: SdkRenderInput): Record<string, string> => {
    const fields = namespaces.map((namespace) => `\t${toPascalCase(namespace.name)} *${toPascalCase(namespace.name)}API`).join("\n");
    const assignments = namespaces.map((namespace) => `\t\t${toPascalCase(namespace.name)}: &${toPascalCase(namespace.name)}API{client: client},`).join("\n");

    const api = [
        GENERATED_HEADER,
        `package ${PACKAGE_NAME}\n`,
        `\n`,
        `import "${RUNTIME_IMPORT}"\n`,
        `\n`,
        `// API is the typed entry point: api.<Namespace>.<Function>(args, shardKey).\n`,
        `type API struct {\n`,
        `${fields}\n`,
        `}\n`,
        `\n`,
        `// NewAPI binds the generated surface to a client.\n`,
        `func NewAPI(client *lunora.Client) *API {\n`,
        `\treturn &API{\n`,
        `${assignments}\n`,
        `\t}\n`,
        `}\n`,
        `\n`,
        namespaces.map((namespace) => renderNamespace(namespace)).join("\n\n"),
        `\n`,
    ].join("");

    // quicktype's Go backend under `just-types` emits bare type declarations
    // with NO `package` clause, so one is prepended here — without it the
    // generated models are not a compilable Go file at all.
    const modelsFile =
        models.length > 0
            ? `${GENERATED_HEADER}package ${PACKAGE_NAME}\n\n${models}\n`
            : `${GENERATED_HEADER}package ${PACKAGE_NAME}\n\n// No typed argument or result schemas in this deployment.\n`;

    return {
        [`${PACKAGE_NAME}/api.go`]: api,
        [`${PACKAGE_NAME}/models.go`]: modelsFile,
        "go.mod": [
            `// The generated Lunora Go SDK, with the transport vendored under ./lunora.\n`,
            `//\n`,
            `// A consuming module wires it in without a network fetch:\n`,
            `//\n`,
            `//\trequire ${MODULE_PATH} v0.0.0\n`,
            `//\treplace ${MODULE_PATH} => ./path/to/this/directory\n`,
            `module ${MODULE_PATH}\n`,
            `\n`,
            `go ${GO_DIRECTIVE}\n`,
        ].join(""),
    };
};

const goTarget: SdkTarget = {
    id: "go",
    quicktype: { lang: "go", rendererOptions: { "just-types": "true", package: PACKAGE_NAME } },
    render,
    // Nothing: the transport is `encoding/json`, `math/big`, `net/url` and
    // `sync`, all standard library.
    requires: [],
    // The transport's `go.mod` is NOT copied — it declares the unpublished
    // `github.com/anolilab/lunora-go`, and a second module file inside the output
    // would cut `lunora/` out of the emitted module entirely.
    vendor: [{ from: "lunora", to: "lunora" }],
};

export default goTarget;
