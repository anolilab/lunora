/**
 * Go SDK target. Emits a single `api.go` plus `models.go` against the
 * hand-written runtime in `sdks/go` (module `github.com/anolilab/lunora-go`).
 *
 * Typed results go through `lunora.Call[T]`, a free function, because Go methods
 * cannot take type parameters — that is what lets a generated method declare a
 * concrete return type while the decode stays generic.
 */

import type { SdkMethod, SdkNamespace } from "../spec";
import { generatedHeaderLines, toPascalCase } from "../spec";
import type { SdkRenderInput, SdkTarget } from "../target";

const GENERATED_HEADER = `${generatedHeaderLines("go")
    .map((line) => `// ${line}`)
    .join("\n")}\n\n`;

/** The package generated code lives in. */
const PACKAGE_NAME = "lunoraapi";

/** The runtime module the generated code imports. */
const RUNTIME_IMPORT = "github.com/anolilab/lunora-go/lunora";

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
    const call = `lunora.Call[${returns}](a.client, ${verb}, "${method.functionPath}", ${payload}, shardKey)`;

    return [
        `// ${memberName(method.functionName)} invokes ${method.summary}.`,
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
        `// ${name} opens a live ${method.functionPath}; it re-runs on every write to the tables it reads.`,
        `func (a *${namespaceType}) ${name}(${argument}onData lunora.DataHandler, onError lunora.ErrorHandler, shardKey string) lunora.Unsubscribe {`,
        `\treturn a.client.Subscribe("${method.functionPath}", ${payload}, onData, onError, shardKey)`,
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

    return [`// ${namespaceType} groups the functions declared in ${namespace.name}.`, `type ${namespaceType} struct{ client *lunora.Client }`, ``, body].join(
        "\n",
    );
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

    return { "api.go": api, "models.go": modelsFile };
};

const goTarget: SdkTarget = {
    id: "go",
    quicktype: { lang: "go", rendererOptions: { "just-types": "true", package: PACKAGE_NAME } },
    render,
    runtimePackage: ["github.com/anolilab/lunora-go"],
};

export default goTarget;
