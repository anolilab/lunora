/**
 * Python SDK target. Emits a package of `__init__.py` / `api.py` / `models.py`
 * against the hand-written runtime in `sdks/python`.
 */

import type { SdkMethod, SdkNamespace } from "../spec";
import { allMethods, generatedHeaderLines, referencedModels, toPascalCase, toSnakeCase } from "../spec";
import type { SdkRenderInput, SdkTarget } from "../target";

/** Python reserved words a function name could collide with. */
const PYTHON_KEYWORDS = new Set([
    "and",
    "as",
    "assert",
    "async",
    "await",
    "break",
    "class",
    "continue",
    "def",
    "del",
    "elif",
    "else",
    "except",
    "False",
    "finally",
    "for",
    "from",
    "global",
    "if",
    "import",
    "in",
    "is",
    "lambda",
    "None",
    "nonlocal",
    "not",
    "or",
    "pass",
    "raise",
    "return",
    "True",
    "try",
    "while",
    "with",
    "yield",
]);

const GENERATED_HEADER = `"""${generatedHeaderLines("python").join("\n\n")}\n"""\n\n`;

/** `listMessages` → `list_messages`; a trailing `_` escapes a keyword. */
const memberName = (raw: string): string => {
    const snake = toSnakeCase(raw);

    return PYTHON_KEYWORDS.has(snake) ? `${snake}_` : snake;
};

/** One function as an `async def` posting the RPC envelope. */
const renderCall = (method: SdkMethod): string => {
    const returns = method.resultType ?? "Any";
    const parameters = method.argsType === undefined ? "self" : `self, args: ${method.argsType}`;
    const payload = method.argsType === undefined ? "{}" : "args.to_dict()";
    const call = `await self._client.${method.verb}("${method.functionPath}", ${payload}, shard_key)`;

    return [
        `    async def ${memberName(method.functionName)}(${parameters}, *, shard_key: Optional[str] = None) -> ${returns}:`,
        `        """${method.summary}"""`,
        `        ${method.resultType === undefined ? `return ${call}` : `return ${method.resultType}.from_dict(${call})`}`,
    ].join("\n");
};

/**
 * A query's live-subscription method. Only queries get one: the WS `subscribe`
 * frame carries a `query.functionPath` the server re-runs on every write to the
 * tables it read, and a write has nothing to re-run.
 */
const renderSubscribe = (method: SdkMethod): string => {
    const payload = method.argsType === undefined ? "{}" : "args.to_dict()";

    const parameters = [
        "self",
        ...(method.argsType === undefined ? [] : [`args: ${method.argsType}`]),
        "on_data: Callback",
        "on_error: Optional[ErrorCallback] = None",
        "*",
        "shard_key: Optional[str] = None",
    ];

    return [
        `    def subscribe_${memberName(method.functionName)}(`,
        ...parameters.map((parameter) => `        ${parameter},`),
        `    ) -> Unsubscribe:`,
        `        """live ${method.summary} — re-runs on every write to the tables it reads."""`,
        `        return self._client.subscribe("${method.functionPath}", ${payload}, on_data, on_error, shard_key)`,
    ].join("\n");
};

const renderNamespaceClass = (namespace: SdkNamespace): string => {
    const body = namespace.methods
        .map((method) => (method.verb === "query" ? `${renderCall(method)}\n\n${renderSubscribe(method)}` : renderCall(method)))
        .join("\n\n");

    return [
        `class ${toPascalCase(namespace.name)}Api:`,
        `    """Functions declared in \`${namespace.name}\`."""`,
        ``,
        `    def __init__(self, client: LunoraClient) -> None:`,
        `        self._client = client`,
        ``,
        body,
    ].join("\n");
};

const render = ({ models, namespaces }: SdkRenderInput): Record<string, string> => {
    const referenced = referencedModels(namespaces);
    const modelImport = referenced.length > 0 ? `from .models import ${referenced.join(", ")}\n` : "";

    // The subscription aliases are imported only when a query produced one, so
    // a write-only SDK does not trip an unused-import lint.
    const hasSubscriptions = allMethods(namespaces).some((method) => method.verb === "query");
    const runtimeImports = hasSubscriptions ? "Callback, ErrorCallback, LunoraClient, Unsubscribe" : "LunoraClient";

    const rootAttributes = namespaces.map((namespace) => `        self.${memberName(namespace.name)} = ${toPascalCase(namespace.name)}Api(client)`).join("\n");

    const api = [
        GENERATED_HEADER,
        `from typing import Any, Optional\n`,
        `\n`,
        `from lunora.client import ${runtimeImports}\n`,
        modelImport,
        `\n\n`,
        namespaces.map((namespace) => renderNamespaceClass(namespace)).join("\n\n\n"),
        `\n\n\n`,
        `class Api:\n`,
        `    """Typed entry point: \`Api(client).<namespace>.<function>(args)\`."""\n`,
        `\n`,
        `    def __init__(self, client: LunoraClient) -> None:\n`,
        rootAttributes.length > 0 ? `${rootAttributes}\n` : `        pass\n`,
    ].join("");

    const exported = ["Api", ...namespaces.map((namespace) => `${toPascalCase(namespace.name)}Api`)];

    return {
        "__init__.py": [
            GENERATED_HEADER,
            `from .api import ${exported.join(", ")}\n`,
            `\n`,
            `__all__ = [${exported.map((name) => `"${name}"`).join(", ")}]\n`,
        ].join(""),
        "api.py": api,
        "models.py": models.length > 0 ? `${GENERATED_HEADER}${models}\n` : `${GENERATED_HEADER}# No typed argument or result schemas in this deployment.\n`,
    };
};

const pythonTarget: SdkTarget = {
    id: "python",
    quicktype: { lang: "python", rendererOptions: { "python-version": "3.7" } },
    render,
    runtimePackage: ["lunora (PyPI)"],
};

export default pythonTarget;

// Exported for its own unit test: the keyword escaping is a Python concern,
// tested at the Python module rather than through the shared contract.
export { memberName };
