import { LunoraError } from "@lunora/errors";
import { jsonSchema } from "ai";

import { SANDBOX_INVOKE_PATH, toFunctionReference } from "./paths";
import type { AgentToolContext, AgentToolDefinition } from "./types";

/**
 * The reference every sandbox tool dispatches through — the internal action
 * `sandboxComponent().invoke`, auto-registered by codegen at `"sandbox:invoke"`.
 * A tool's `execute` runs inside the loop's durable step, which has no direct
 * `ctx.browser`/`ctx.containers`; it reaches them by dispatching this action
 * (an action ctx carries both), exactly like a `functionTool`.
 */
const SANDBOX_REF = toFunctionReference(SANDBOX_INVOKE_PATH);

/**
 * The model-provided input to a {@link browserTool} call — a discriminated
 * union on `op` so one tool exposes every headless-browser capability.
 * @experimental
 */
type BrowserToolInput =
    | { fullPage?: boolean; op: "screenshot"; type?: "jpeg" | "png"; url: string }
    | { op: "content"; url: string }
    | { op: "pdf"; url: string }
    | { op: "scrape"; selector?: string; url: string };

/**
 * The model-provided input to a {@link containerTool} call — a discriminated
 * union on `op`. `fetch` sends an HTTP request to the container; `exec` asks it
 * to run a command (routed as a POST to `/exec`, since the container surface
 * exposes no first-class exec RPC — the container app must serve that route).
 * @experimental
 */
type ContainerToolInput = { args?: string[]; command?: string; op: "exec" } | { body?: string; method?: string; op: "fetch"; path: string };

/**
 * Author-supplied config for `browserTool`.
 * @experimental
 */
interface BrowserToolOptions {
    /** Override the model-facing description (what the tool does). */
    description?: string;

    /**
     * Gate a call behind a human approval. Defaults to **unattended** (no gate),
     * matching the AI SDK. `browserTool` fetches a model-chosen `url` with no
     * allowlist, so it is an SSRF surface: a prompt-injected model can point it at
     * an internal/link-local address and read the response back into context. Pass
     * a boolean or a predicate to gate it (evaluated from replay-stable input, so
     * keep it deterministic).
     */
    needsApproval?: ((input: BrowserToolInput) => boolean) | boolean;
}

/**
 * The model-provided input to a {@link fsTool} call — a discriminated union on
 * `op` over an R2-backed virtual filesystem. Paths are relative to the tool's
 * pinned `root`; a `..` that escapes the root is rejected server-side.
 * @experimental
 */
type FsToolInput =
    | { op: "ls"; path?: string }
    | { op: "read"; path: string }
    | { op: "rm"; path: string }
    | { op: "stat"; path: string }
    | { content: string; op: "write"; path: string };

/**
 * Author-supplied config for `fsTool`.
 * @experimental
 */
interface FsToolOptions {
    /** Override the model-facing description (what the tool does). */
    description?: string;

    /**
     * Gate a call behind a human approval. Defaults to gating the WRITING ops
     * (`write`, `rm`) — a prompt-injected model shouldn't silently overwrite or
     * delete the sandbox — while `ls`/`read`/`stat` run unattended. Pass a boolean
     * or a predicate (evaluated from replay-stable input, so keep it deterministic).
     */
    needsApproval?: ((input: FsToolInput) => boolean) | boolean;

    /**
     * The key prefix every path is scoped under, isolating this tool's files from
     * the rest of the bucket. Either a fixed string (e.g. `"agents/support"`) or a
     * function of the tool context — return `` `agents/${ctx.threadKey}` `` (or an
     * owner-derived prefix) to give each run/user its OWN namespace in a
     * multi-tenant agent. Default: the bucket root (shared — set a root for
     * multi-tenant use). The server rejects any `..` that would escape it.
     */
    root?: ((context: AgentToolContext) => string) | string;
}

/**
 * Author-supplied config for `containerTool`.
 * @experimental
 */
interface ContainerToolOptions {
    /** Override the model-facing description (what the tool does). */
    description?: string;

    /**
     * Gate a call behind a human approval. Defaults to gating any command
     * execution: an `exec`, AND a `fetch` whose path resolves to the privileged
     * `/exec` route (both reach the same command-execution path in the container,
     * so gating on the `op` name alone would let a `fetch` to `/exec` run a
     * command unattended). A plain `fetch` to any other route runs unattended.
     * Pass a boolean or your own predicate to change that. Evaluated from
     * replay-stable input, so keep it deterministic.
     */
    needsApproval?: ((input: ContainerToolInput) => boolean) | boolean;
}

const DEFAULT_BROWSER_DESCRIPTION =
    "Drive a headless browser: screenshot a page, render it to PDF, read its HTML content, or scrape it. " +
    'Set `op` to "screenshot" | "pdf" | "content" | "scrape" and pass the target `url`.';

const DEFAULT_CONTAINER_DESCRIPTION =
    "Talk to a sandboxed container: `fetch` an HTTP path on it, or `exec` a command inside it. " +
    'Set `op` to "fetch" (with `path`) or "exec" (with `command`).';

const DEFAULT_FS_DESCRIPTION =
    "Read and write files in a persistent sandbox filesystem. " +
    'Set `op` to "ls" (list a directory), "read", "write" (with `content`), "rm", or "stat", and pass `path`.';

/** The default gate for `fsTool` — writing ops (`write`/`rm`) pause for approval; reads run unattended. */
const defaultFsGate = (input: FsToolInput): boolean => input.op === "write" || input.op === "rm";

const FS_TOOL_SCHEMA = jsonSchema<FsToolInput>({
    properties: {
        content: { description: "write: the file contents.", type: "string" },
        op: { description: "The filesystem operation to run.", enum: ["ls", "read", "write", "rm", "stat"], type: "string" },
        path: { description: "The file or directory path, relative to the sandbox root.", type: "string" },
    },
    required: ["op"],
    type: "object",
});

const BROWSER_TOOL_SCHEMA = jsonSchema<BrowserToolInput>({
    properties: {
        fullPage: { description: "screenshot: capture the full scrollable page rather than just the viewport.", type: "boolean" },
        op: { description: "The browser operation to run.", enum: ["screenshot", "scrape", "pdf", "content"], type: "string" },
        selector: { description: "scrape: optional CSS selector hint to narrow the extraction.", type: "string" },
        type: { description: "screenshot: image encoding (default png).", enum: ["png", "jpeg"], type: "string" },
        url: { description: "The URL to operate on.", type: "string" },
    },
    required: ["op", "url"],
    type: "object",
});

/** The privileged route the container `exec` op POSTs to (see `runContainerOp` in `sandbox-component`). */
const CONTAINER_EXEC_ROUTE = "/exec";

/** Splits a container fetch `path` off its query/fragment. Hoisted to avoid per-call recompilation. */
const CONTAINER_PATH_QUERY_SPLIT = /[?#]/u;

/**
 * Normalize a container fetch `path` to its resolved route so the default gate
 * can tell whether a `fetch` reaches the privileged `/exec` route. Strips the
 * query/fragment and resolves empty/`.`/`..` segments — `"/exec"`, `"exec"`,
 * `"//exec"`, `"/./exec"`, and `"/foo/../exec"` all normalize to `"/exec"`.
 */
const normalizeContainerPath = (path: string | undefined): string => {
    const [raw = ""] = (path ?? "").split(CONTAINER_PATH_QUERY_SPLIT);
    const segments: string[] = [];

    for (const segment of raw.split("/")) {
        if (segment === "" || segment === ".") {
            continue;
        }

        if (segment === "..") {
            segments.pop();

            continue;
        }

        segments.push(segment);
    }

    return `/${segments.join("/")}`;
};

/**
 * The default human-in-the-loop gate for `containerTool`. Gates command
 * execution — an `exec`, AND a `fetch` whose path resolves to the privileged
 * `/exec` route, since both reach the same command-execution path in the
 * container. A plain `fetch` to any other route runs unattended.
 */
const defaultContainerGate = (input: ContainerToolInput): boolean => {
    if (input.op === "exec") {
        return true;
    }

    // Narrowed to the `fetch` variant: gate it iff its path resolves to `/exec`.
    return normalizeContainerPath(input.path) === CONTAINER_EXEC_ROUTE;
};

const CONTAINER_TOOL_SCHEMA = jsonSchema<ContainerToolInput>({
    properties: {
        args: { description: "exec: command arguments.", items: { type: "string" }, type: "array" },
        body: { description: "fetch: request body.", type: "string" },
        command: { description: "exec: the command to run.", type: "string" },
        method: { description: "fetch: HTTP method (default GET).", type: "string" },
        op: { description: "The container operation to run.", enum: ["fetch", "exec"], type: "string" },
        path: { description: "fetch: request path on the container (e.g. /health).", type: "string" },
    },
    required: ["op"],
    type: "object",
});

/**
 * A batteries-included agent tool that drives Cloudflare Browser Rendering. One
 * tool exposes every browser op (screenshot / pdf / content / scrape); the model
 * picks via `op`. The call dispatches to the auto-registered `sandbox:invoke`
 * action — which runs on an action ctx carrying `ctx.browser`. Importing the tool
 * makes codegen register the dispatcher and provision the `BROWSER` binding; like
 * any `ctx.browser` user, the app still supplies a `config.browser` thunk
 * (`createBrowser({ binding: env.BROWSER, launch })` with the optional
 * `@cloudflare/playwright` `launch` peer) to `createShardDO()` — codegen never
 * injects that peer, so the browser op throws a directed error until it is wired.
 *
 * Security: the model chooses the `url` with no allowlist, so this is an SSRF
 * surface — pass `opts.needsApproval` to gate calls a prompt-injected model
 * could aim at internal/link-local endpoints.
 *
 * ```ts
 * import { browserTool, defineAgent } from "@lunora/agent/sandbox";
 *
 * export const researcher = defineAgent({
 *     model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
 *     tools: { browser: browserTool() },
 * });
 * ```
 * @experimental
 */
const browserTool = (options: BrowserToolOptions = {}): AgentToolDefinition<BrowserToolInput, string> => {
    return {
        description: options.description ?? DEFAULT_BROWSER_DESCRIPTION,
        // Pin `kind` LAST so out-of-schema model input can never override it.
        execute: (input, context: AgentToolContext) => context.run(SANDBOX_REF, { ...input, kind: "browser" }) as Promise<string>,
        inputSchema: BROWSER_TOOL_SCHEMA,
        isLunoraAgentTool: true,
        ...(options.needsApproval === undefined ? {} : { needsApproval: options.needsApproval }),
    };
};

/**
 * A batteries-included agent tool that talks to a declared Cloudflare
 * Container. `name` is the `ctx.containers.&lt;name>` key (the `lunora/containers.ts`
 * export). One tool exposes `fetch` (HTTP request) and `exec` (run a command);
 * the model picks via `op`. The call dispatches to the auto-registered
 * `sandbox:invoke` action, which carries `ctx.containers`.
 *
 * By default a `fetch` runs unattended while command execution is gated behind a
 * human approval — an `exec`, AND a `fetch` whose path resolves to the privileged
 * `/exec` route (both reach the same command-execution path in the container, so
 * gating on the `op` name alone would let a `fetch` to `/exec` run a command
 * unattended). Note a `fetch` can still reach any *other* container route
 * unattended, so scope the container's routes accordingly. Pass
 * `opts.needsApproval` to widen or disable the gate.
 *
 * ```ts
 * import { containerTool, defineAgent } from "@lunora/agent/sandbox";
 *
 * export const ops = defineAgent({
 *     model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
 *     tools: { sandbox: containerTool("sandbox") },
 * });
 * ```
 * @experimental
 */
const containerTool = (name: string, options: ContainerToolOptions = {}): AgentToolDefinition<ContainerToolInput, string> => {
    if (typeof name !== "string" || name.length === 0) {
        throw new LunoraError("INTERNAL", "@lunora/agent: containerTool requires a container `name` (the ctx.containers.<name> key from lunora/containers.ts)");
    }

    // Default gate: any command execution. A fetch to a non-exec route is a
    // read/RPC that runs unattended; an exec — or a fetch that resolves to the
    // `/exec` route — runs arbitrary commands, so it pauses for approval unless
    // overridden.
    const needsApproval: ((input: ContainerToolInput) => boolean) | boolean = options.needsApproval ?? defaultContainerGate;

    return {
        description: options.description ?? DEFAULT_CONTAINER_DESCRIPTION,
        // Pin `kind`/`name` LAST so out-of-schema model input can never override
        // the authoritative container the author pinned.
        execute: (input, context: AgentToolContext) => context.run(SANDBOX_REF, { ...input, kind: "container", name }) as Promise<string>,
        inputSchema: CONTAINER_TOOL_SCHEMA,
        isLunoraAgentTool: true,
        needsApproval,
    };
};

/**
 * A batteries-included agent tool exposing a persistent, R2-backed virtual
 * filesystem. `bucket` is the R2 binding name; every path is scoped under the
 * pinned `opts.root` (a `..` that would escape it is rejected). One tool exposes
 * `ls`/`read`/`write`/`rm`/`stat`; the model picks via `op`. The call dispatches
 * to the auto-registered `sandbox:invoke` action, which reads the bucket from
 * `ctx.env`. workerd has no real shell — this is object-store-backed file I/O.
 *
 * By default the writing ops (`write`/`rm`) pause for a human approval while
 * reads run unattended; pass `opts.needsApproval` to change that. Importing the
 * tool registers the dispatcher; the app must declare the `r2_bucket` binding in
 * `wrangler.jsonc` (the fs op throws a directed error until it is wired).
 *
 * ```ts
 * import { defineAgent, fsTool } from "@lunora/agent/sandbox";
 *
 * export const coder = defineAgent({
 *     model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
 *     tools: { fs: fsTool("SANDBOX_BUCKET", { root: "agents/coder" }) },
 * });
 * ```
 * @experimental
 */
const fsTool = (bucket: string, options: FsToolOptions = {}): AgentToolDefinition<FsToolInput> => {
    if (typeof bucket !== "string" || bucket.length === 0) {
        throw new LunoraError("INTERNAL", "@lunora/agent: fsTool requires an R2 `bucket` binding name (the r2_bucket declared in wrangler.jsonc)");
    }

    return {
        description: options.description ?? DEFAULT_FS_DESCRIPTION,
        // Pin kind/bucket/root LAST so out-of-schema model input can never override
        // the authoritative bucket + sandbox root the author pinned. `root` may be
        // a function of the ctx (per-run/owner isolation), resolved here.
        execute: (input, context: AgentToolContext) => {
            const root = typeof options.root === "function" ? options.root(context) : (options.root ?? "");

            return context.run(SANDBOX_REF, { ...input, bucket, kind: "fs", root });
        },
        inputSchema: FS_TOOL_SCHEMA,
        isLunoraAgentTool: true,
        needsApproval: options.needsApproval ?? defaultFsGate,
    };
};

export type { BrowserToolInput, BrowserToolOptions, ContainerToolInput, ContainerToolOptions, FsToolInput, FsToolOptions };
export { browserTool, containerTool, fsTool };
