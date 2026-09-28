import { LunoraError } from "@lunora/errors";
import { jsonSchema } from "ai";

import type { AgentToolContext, AgentToolDefinition } from "./types";

/**
 * The slice of a Worker Loader binding (`worker_loaders` in wrangler, Dynamic
 * Workers on celld) this tool calls. Declared structurally so `@lunora/agent`
 * needs no `@cloudflare/workers-types` dependency.
 */
interface WorkerLoaderLike {
    load: (code: {
        compatibilityDate: string;
        env: Record<string, never>;
        globalOutbound: null;
        limits: { cpuMs: number; subRequests: number };
        mainModule: string;
        modules: Record<string, string>;
    }) => { getEntrypoint: () => { fetch: (input: string) => Promise<Response> } };
}

/**
 * The model-provided input to a {@link jsCodeTool} call.
 * @experimental
 */
interface JsCodeToolInput {
    /** The body of an `async` function. Its `return` value is the result. */
    code: string;
}

/**
 * What a {@link jsCodeTool} call resolves to. `error` is set instead of `value`
 * when the script threw, did not parse, returned something that is not JSON,
 * or ran out of time.
 * @experimental
 */
interface JsCodeToolResult {
    error?: string;
    /** `console.*` output, one entry per call, at most {@link MAX_LOG_ENTRIES}. */
    logs: string[];
    value?: unknown;
}

/** Options for {@link jsCodeTool}. */
interface JsCodeToolOptions {
    /** CPU budget per run, enforced by the loader. Default 1000 ms. */
    cpuMs?: number;
    /** Tool description shown to the model. */
    description?: string;
}

/** The binding `@lunora/config` provisions in `worker_loaders` when it sees this tool. */
const LOADER_BINDING = "LOADER";

/** Pinned so the loaded isolate's runtime behavior does not drift with the host's date. */
const SANDBOX_COMPATIBILITY_DATE = "2026-04-07";
const DEFAULT_CPU_MS = 1000;
const MAX_LOG_ENTRIES = 100;
const MAX_LOG_ENTRY_CHARS = 2000;

/** Well under the 1 MiB step-result cap, which the result's JSON shares with the rest of the step. */
const MAX_RESULT_BYTES = 256 * 1024;

/**
 * Wall-clock ceiling for one run. The CPU limit stops a busy loop, not a script
 * that awaits forever, so this bounds the tool's durable step either way.
 */
const WALL_TIMEOUT_MS = 30_000;

const DEFAULT_DESCRIPTION =
    "Run JavaScript in an isolated sandbox and get its result. Provide `code`: the body of an async function — `return` the answer. " +
    "Use it for calculation, parsing and data transformation. The sandbox has no network, no bindings and no tools; `console.log` output is returned as `logs`.";

const JS_CODE_TOOL_SCHEMA = jsonSchema<JsCodeToolInput>({
    additionalProperties: false,
    properties: { code: { description: "The body of an async function. `return` the result; it must be JSON-serializable.", type: "string" } },
    required: ["code"],
    type: "object",
});

/**
 * The loaded Worker's only module. The script runs as an async function body
 * with `console` shadowed by a recorder, and whatever it returns — or throws —
 * comes back as one JSON response. Anything the script does to escape the
 * wrapper only changes its own isolate's output, which the caller already
 * treats as untrusted.
 */
const sandboxModule = (code: string): string => `const logs = [];
const format = (value) => { if (typeof value === "string") return value; try { return JSON.stringify(value); } catch { return String(value); } };
const record = (...values) => { if (logs.length < ${String(MAX_LOG_ENTRIES)}) logs.push(values.map(format).join(" ")); };
const sandboxConsole = { debug: record, error: record, info: record, log: record, warn: record };
const run = async (console) => {
${code}
};
export default {
    async fetch() {
        try {
            const value = await run(sandboxConsole);
            return new Response(JSON.stringify({ logs, value: value === undefined ? null : value }));
        } catch (error) {
            return new Response(JSON.stringify({ error: error instanceof Error ? (error.stack ?? error.message) : String(error), logs }));
        }
    },
};
`;

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Read the sandbox's response, giving up past `limit` bytes. The script builds
 * its result inside its own budget, but parsing it happens HERE, in the agent's
 * isolate — and the whole result is then memoized as a step result, which the
 * host caps at 1 MiB and retries (not fails) when exceeded. So an oversized
 * result is cut off while streaming and becomes an `error`, never a parse.
 */
const readCapped = async (response: Response, limit: number): Promise<string | undefined> => {
    const reader = response.body?.getReader();

    if (reader === undefined) {
        return "";
    }

    const decoder = new TextDecoder();
    let text = "";
    let size = 0;

    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- a stream is read one chunk at a time
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        size += value.byteLength;

        if (size > limit) {
            // eslint-disable-next-line no-await-in-loop -- the loop ends here; cancel releases the rest of the stream
            await reader.cancel();

            return undefined;
        }

        text += decoder.decode(value, { stream: true });
    }

    return text + decoder.decode();
};

/**
 * Enforce the log caps on the host: the wrapper's `record` bounds honest
 * scripts, but `logs` is in the script's own scope, so a script can push past it.
 */
const capLogs = (logs: unknown): string[] =>
    (Array.isArray(logs) ? logs : []).slice(0, MAX_LOG_ENTRIES).map((entry) => String(entry).slice(0, MAX_LOG_ENTRY_CHARS));

const runInLoader = async (loader: WorkerLoaderLike, code: string, cpuMs: number): Promise<JsCodeToolResult> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<JsCodeToolResult>((resolve) => {
        timer = setTimeout(() => {
            resolve({ error: `the script did not finish within ${String(WALL_TIMEOUT_MS)} ms`, logs: [] });
        }, WALL_TIMEOUT_MS);
    });

    const run = async (): Promise<JsCodeToolResult> => {
        // `load`, not `get(id)`: every script is new, so a memoised isolate would
        // only pin memory. `globalOutbound: null` and an empty `env` leave the
        // script no way out of its isolate.
        const worker = loader.load({
            compatibilityDate: SANDBOX_COMPATIBILITY_DATE,
            env: {},
            // eslint-disable-next-line unicorn/no-null -- the Worker Loader API removes every connection only for an explicit null
            globalOutbound: null,
            limits: { cpuMs, subRequests: 0 },
            mainModule: "main.js",
            modules: { "main.js": sandboxModule(code) },
        });
        const response = await worker.getEntrypoint().fetch("https://sandbox/");
        const text = await readCapped(response, MAX_RESULT_BYTES);

        if (text === undefined) {
            return { error: `the script's result is over ${String(MAX_RESULT_BYTES)} bytes — return less`, logs: [] };
        }

        const parsed = JSON.parse(text) as { error?: unknown; logs?: unknown; value?: unknown };
        const logs = capLogs(parsed.logs);

        return typeof parsed.error === "string" ? { error: parsed.error, logs } : { logs, value: parsed.value };
    };

    try {
        return await Promise.race([run(), timeout]);
    } catch (error) {
        // A syntax error or an exceeded CPU limit rejects the call itself.
        return { error: describeError(error), logs: [] };
    } finally {
        clearTimeout(timer);
    }
};

/**
 * A batteries-included agent tool that runs model-written JavaScript in a
 * Worker Loader isolate — Cloudflare's Dynamic Workers, which celld implements
 * too. The script gets no network (`globalOutbound: null`), no bindings, no
 * tools and a CPU budget, so it is for computation: arithmetic, parsing,
 * reshaping data the model already has. It returns the script's JSON result
 * and its `console` output. A failure comes back as a result with `error` set,
 * not a throw, so the durable step does not retry a script that will fail the
 * same way again.
 *
 * Importing the tool makes codegen provision the `worker_loaders` binding
 * (`LOADER`) and refuse a target whose matrix rates `workerLoaders`
 * `unsupported`.
 *
 * ```ts
 * import { defineAgent, jsCodeTool } from "@lunora/agent";
 *
 * export const analyst = defineAgent({
 *     model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
 *     tools: { js: jsCodeTool() },
 * });
 * ```
 * @experimental
 */
const jsCodeTool = (options: JsCodeToolOptions = {}): AgentToolDefinition<JsCodeToolInput, JsCodeToolResult> => {
    const cpuMs = options.cpuMs ?? DEFAULT_CPU_MS;

    if (!Number.isInteger(cpuMs) || cpuMs <= 0) {
        throw new LunoraError("INTERNAL", "@lunora/agent: jsCodeTool `cpuMs` must be a positive integer");
    }

    return {
        description: options.description ?? DEFAULT_DESCRIPTION,
        execute: async (input, context: AgentToolContext) => {
            const loader = context.env[LOADER_BINDING] as WorkerLoaderLike | undefined;

            if (typeof loader?.load !== "function") {
                return {
                    error: `jsCodeTool: no Worker Loader binding "${LOADER_BINDING}" on env — declare \`"worker_loaders": [{ "binding": "${LOADER_BINDING}" }]\` in wrangler.jsonc`,
                    logs: [],
                };
            }

            return runInLoader(loader, input.code, cpuMs);
        },
        inputSchema: JS_CODE_TOOL_SCHEMA,
        isLunoraAgentTool: true,
    };
};

export type { JsCodeToolInput, JsCodeToolOptions, JsCodeToolResult, WorkerLoaderLike };
export { jsCodeTool };
