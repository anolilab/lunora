import { LunoraError } from "@lunora/errors";
import { initLunora } from "@lunora/server";
import { v } from "@lunora/values";

import { toBase64 } from "../../../shared/base64";

// The runtime function is built with the base procedure builders (no generated
// server inside a package), same as the agent + presence components. This file
// stays free of the `ai` SDK so it tree-shakes into the `/component` subpath the
// codegen emitter imports at emit time.
const { internalAction } = initLunora.dataModel().create();

/** Extract the page's HTML — runs INSIDE the headless page, where `document` is the DOM. */
const sandboxScrapeDocument = (): string =>
    (globalThis as { document?: { documentElement?: { outerHTML?: string } } }).document?.documentElement?.outerHTML ?? "";

/**
 * Structural view of the `ctx.browser` surface (`@lunora/browser`). Kept minimal
 * and local so this file stays free of the browser package and its DOM types —
 * codegen weaves the real `ctx.browser` onto the action ctx.
 */
interface SandboxBrowserSurface {
    content: (url: string) => Promise<string>;
    pdf: (url: string) => Promise<Uint8Array>;
    scrape: <T>(url: string, function_: (...arguments_: never[]) => T) => Promise<T>;
    screenshot: (url: string, options?: { fullPage?: boolean; type?: "jpeg" | "png" }) => Promise<Uint8Array>;
}

/** Structural view of a `ctx.containers.<name>` accessor + its fetch handle. */
interface SandboxContainerAccessor {
    any: () => {
        fetch: (input: string, init?: { body?: string; headers?: Record<string, string>; method?: string }) => Promise<{ text: () => Promise<string> }>;
    };
}

/** Structural view of one listed R2 object. */
interface R2ObjectLike {
    key: string;
    size: number;
}

/** Structural subset of the Cloudflare `R2Bucket` binding the fs sandbox uses. */
interface R2BucketLike {
    delete: (key: string) => Promise<void>;
    get: (key: string) => Promise<{ text: () => Promise<string> } | null>;
    head: (key: string) => Promise<R2ObjectLike | null>;
    list: (options?: {
        cursor?: string;
        limit?: number;
        prefix?: string;
    }) => Promise<{ cursor?: string; objects: ReadonlyArray<R2ObjectLike>; truncated?: boolean }>;
    put: (key: string, value: string) => Promise<unknown>;
}

/** Max bytes read/written in one fs op — bounds Worker memory + prompt/token cost (model input is untrusted). */
const MAX_FS_BYTES = 1_000_000;

/** Max R2 list pages walked for one `ls` (each ~1000 objects) before surfacing `truncated`. */
const MAX_LS_PAGES = 20;

const fsEncoder = new TextEncoder();

/** The action ctx the dispatcher casts to — codegen attaches these on an action ctx. */
interface SandboxActionContext {
    browser?: SandboxBrowserSurface;
    containers?: Record<string, SandboxContainerAccessor>;
    /** The Worker env bindings — the fs sandbox reads its R2 bucket from here. */
    env?: Record<string, unknown>;
}

/** Args the browser/container/fs tools dispatch — a flat superset of the unions. */
interface SandboxInvokeArgs {
    args?: string[];
    body?: string;
    /** fs: the R2 bucket binding name. */
    bucket?: string;
    command?: string;
    /** fs: content for a `write`. */
    content?: string;
    fullPage?: boolean;
    kind: "browser" | "container" | "fs";
    method?: string;
    name?: string;
    op: string;
    path?: string;
    /** fs: the author-pinned prefix the tool is scoped under. */
    root?: string;
    selector?: string;
    type?: string;
    url?: string;
}

/**
 * Loose structural view of the registered sandbox action — wide enough for the
 * concrete `RegisteredAction`, narrow enough for re-export + dispatch. Codegen
 * registers the runtime value; it never needs the precise generics.
 * @experimental
 */
interface SandboxRegisteredFunction {
    readonly args: unknown;
    readonly handler: (context: unknown, args: never) => unknown;
    readonly kind: "action";
    readonly visibility?: "internal" | "public";
}

/**
 * `SandboxComponent` is part of the experimental `@lunora/agent` API and may change without a major version bump.
 * @experimental
 */
interface SandboxComponent {
    invoke: SandboxRegisteredFunction;
}

const runBrowserOp = async (browser: SandboxBrowserSurface, request: SandboxInvokeArgs): Promise<unknown> => {
    const url = request.url ?? "";

    switch (request.op) {
        case "content": {
            return browser.content(url);
        }
        case "pdf": {
            return { data: toBase64(await browser.pdf(url)), encoding: "base64", mediaType: "application/pdf" };
        }
        case "scrape": {
            // The scrape extractor runs in the page and cannot close over
            // `selector` (Playwright serializes only the function), so it returns
            // the page HTML for the model to narrow; `selector` is an advisory hint.
            return browser.scrape(url, sandboxScrapeDocument);
        }
        case "screenshot": {
            const bytes = await browser.screenshot(url, {
                ...(request.fullPage === undefined ? {} : { fullPage: request.fullPage }),
                ...(request.type === undefined ? {} : { type: request.type as "jpeg" | "png" }),
            });

            return { data: toBase64(bytes), encoding: "base64", mediaType: request.type === "jpeg" ? "image/jpeg" : "image/png" };
        }
        default: {
            throw new LunoraError("INTERNAL", `@lunora/agent: sandbox browser op "${request.op}" is not supported`);
        }
    }
};

const runContainerOp = async (accessor: SandboxContainerAccessor, request: SandboxInvokeArgs): Promise<string> => {
    const handle = accessor.any();

    if (request.op === "exec") {
        // No first-class exec RPC on the container surface — route it as a POST
        // to `/exec` carrying the command; the container app serves that route.
        const response = await handle.fetch("/exec", {
            body: JSON.stringify({ args: request.args ?? [], command: request.command ?? "" }),
            headers: { "content-type": "application/json" },
            method: "POST",
        });

        return response.text();
    }

    if (request.op === "fetch") {
        const response = await handle.fetch(request.path ?? "/", {
            ...(request.body === undefined ? {} : { body: request.body }),
            method: request.method ?? "GET",
        });

        return response.text();
    }

    throw new LunoraError("INTERNAL", `@lunora/agent: sandbox container op "${request.op}" is not supported`);
};

/** Strip leading/trailing `/` without a regex (avoids backtracking / recompilation). */
const trimSlashes = (value: string): string => {
    let start = 0;
    let end = value.length;

    while (start < end && value[start] === "/") {
        start += 1;
    }

    while (end > start && value[end - 1] === "/") {
        end -= 1;
    }

    return value.slice(start, end);
};

/**
 * Resolve a model-supplied `path` to an absolute R2 key UNDER `root`, rejecting
 * any `..` that would escape the sandbox root. Every returned key is guaranteed
 * to start with the normalized `root`, so the model can never read or write
 * outside its own prefix — the fs sandbox's core isolation guarantee.
 */
const resolveFsKey = (root: string, path: string): string => {
    const base = trimSlashes(root);
    const segments: string[] = [];

    for (const segment of path.split("/")) {
        if (segment === "" || segment === ".") {
            continue;
        }

        if (segment === "..") {
            if (segments.length === 0) {
                throw new LunoraError("BAD_REQUEST", "@lunora/agent: fs path escapes the sandbox root");
            }

            segments.pop();

            continue;
        }

        segments.push(segment);
    }

    const relative = segments.join("/");

    return base && relative ? `${base}/${relative}` : base || relative;
};

/**
 * List a directory across R2 list-cursor pages (root-relative keys), bounded by
 * `MAX_LS_PAGES` so a huge prefix can't spin unboundedly — `truncated` signals
 * the listing was cut off. Extracted from `runFsOp` to keep its complexity flat.
 */
const listFsEntries = async (bucket: R2BucketLike, key: string, base: string): Promise<{ entries: string[]; truncated: boolean }> => {
    const prefix = key.length > 0 ? `${key}/` : "";
    // Strip the sandbox root so the model sees root-relative paths.
    const strip = base.length > 0 ? base.length + 1 : 0;
    const entries: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_LS_PAGES; page += 1) {
        // eslint-disable-next-line no-await-in-loop -- cursor pagination is inherently sequential
        const result = await bucket.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });

        for (const object of result.objects) {
            entries.push(object.key.slice(strip));
        }

        if (!result.truncated || result.cursor === undefined) {
            return { entries, truncated: false };
        }

        cursor = result.cursor;
    }

    return { entries, truncated: true };
};

/**
 * Run one R2-backed virtual-filesystem op, scoped under `root`. `ls` lists the
 * keys under a directory (root-relative), `read`/`write`/`rm`/`stat` operate on a
 * single file. workerd has no real shell; this is a persistent object-store FS.
 */
const runFsOp = async (bucket: R2BucketLike, root: string, request: SandboxInvokeArgs): Promise<unknown> => {
    const base = trimSlashes(root);
    const key = resolveFsKey(root, request.path ?? "");

    switch (request.op) {
        case "ls": {
            const { entries, truncated } = await listFsEntries(bucket, key, base);

            return truncated ? { entries, truncated: true } : { entries };
        }
        case "read": {
            // Reject an oversized object BEFORE pulling it into memory/context.
            const head = await bucket.head(key);

            if (head && head.size > MAX_FS_BYTES) {
                throw new LunoraError(
                    "BAD_REQUEST",
                    `@lunora/agent: fs read: "${request.path ?? ""}" is ${String(head.size)} bytes (max ${String(MAX_FS_BYTES)})`,
                );
            }

            const object = await bucket.get(key);

            if (!object) {
                throw new LunoraError("NOT_FOUND", `@lunora/agent: fs read: no file at "${request.path ?? ""}"`);
            }

            return object.text();
        }
        case "rm": {
            await bucket.delete(key);

            return { path: request.path ?? "", removed: true };
        }
        case "stat": {
            const head = await bucket.head(key);

            return head ? { exists: true, size: head.size } : { exists: false };
        }
        case "write": {
            const content = request.content ?? "";
            const bytes = fsEncoder.encode(content).length;

            if (bytes > MAX_FS_BYTES) {
                throw new LunoraError("BAD_REQUEST", `@lunora/agent: fs write: ${String(bytes)} bytes exceeds the max (${String(MAX_FS_BYTES)})`);
            }

            await bucket.put(key, content);

            return { bytes, path: request.path ?? "", wrote: true };
        }
        default: {
            throw new LunoraError("INTERNAL", `@lunora/agent: sandbox fs op "${request.op}" is not supported`);
        }
    }
};

/**
 * Build the sandbox runtime component: the single internal action the
 * batteries-included `browserTool`/`containerTool` dispatch to. Codegen
 * auto-registers it at `sandbox:invoke` whenever `lunora/` imports a sandbox
 * tool. It runs as an **action** because that is the only ctx codegen attaches
 * `ctx.browser` to (and `ctx.containers` rides every ctx once a container is
 * declared) — the durable tool step itself has neither.
 * @experimental
 */
const sandboxComponent = (): SandboxComponent => {
    const invoke = internalAction
        .input({
            args: v.optional(v.array(v.string())),
            body: v.optional(v.string()),
            bucket: v.optional(v.string()),
            command: v.optional(v.string()),
            content: v.optional(v.string()),
            fullPage: v.optional(v.boolean()),
            kind: v.union(v.literal("browser"), v.literal("container"), v.literal("fs")),
            method: v.optional(v.string()),
            name: v.optional(v.string()),
            op: v.string(),
            path: v.optional(v.string()),
            root: v.optional(v.string()),
            selector: v.optional(v.string()),
            type: v.optional(v.string()),
            url: v.optional(v.string()),
        })
        .action(async ({ args, ctx: context }): Promise<unknown> => {
            const surface = context as SandboxActionContext;
            const request = args as SandboxInvokeArgs;

            if (request.kind === "browser") {
                if (!surface.browser) {
                    throw new LunoraError("INTERNAL", "@lunora/agent: sandbox browser op needs `ctx.browser` — install @lunora/browser and run codegen");
                }

                return runBrowserOp(surface.browser, request);
            }

            if (request.kind === "fs") {
                const bucket = surface.env?.[request.bucket ?? ""] as R2BucketLike | undefined;

                if (!bucket || typeof bucket.get !== "function") {
                    throw new LunoraError(
                        "INTERNAL",
                        `@lunora/agent: sandbox fs op found no R2 bucket "${request.bucket ?? ""}" on env — declare the r2_bucket binding in wrangler.jsonc and run codegen`,
                    );
                }

                return runFsOp(bucket, request.root ?? "", request);
            }

            const name = request.name ?? "";
            const accessor = surface.containers?.[name];

            if (!accessor) {
                throw new LunoraError(
                    "INTERNAL",
                    `@lunora/agent: sandbox container op found no ctx.containers["${name}"] — declare the container in lunora/containers.ts and run codegen`,
                );
            }

            return runContainerOp(accessor, request);
        });

    return { invoke };
};

export type { R2BucketLike, SandboxComponent, SandboxInvokeArgs, SandboxRegisteredFunction };
export { resolveFsKey, runFsOp, sandboxComponent };
