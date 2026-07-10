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

/** Structural view of a `ctx.containers.&lt;name>` accessor + its fetch handle. */
interface SandboxContainerAccessor {
    any: () => {
        fetch: (input: string, init?: { body?: string; headers?: Record<string, string>; method?: string }) => Promise<{ text: () => Promise<string> }>;
    };
}

/** The action ctx the dispatcher casts to — codegen attaches these on an action ctx. */
interface SandboxActionContext {
    browser?: SandboxBrowserSurface;
    containers?: Record<string, SandboxContainerAccessor>;
}

/** Args the browser/container tools dispatch — a flat superset of both unions. */
interface SandboxInvokeArgs {
    args?: string[];
    body?: string;
    command?: string;
    fullPage?: boolean;
    kind: "browser" | "container";
    method?: string;
    name?: string;
    op: string;
    path?: string;
    selector?: string;
    type?: string;
    url?: string;
}

/**
 * Loose structural view of the registered sandbox action — wide enough for the
 * concrete `RegisteredAction`, narrow enough for re-export + dispatch. Codegen
 * registers the runtime value; it never needs the precise generics.
 */
interface SandboxRegisteredFunction {
    readonly args: unknown;
    readonly handler: (context: unknown, args: never) => unknown;
    readonly kind: "action";
    readonly visibility?: "internal" | "public";
}

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

/**
 * Build the sandbox runtime component: the single internal action the
 * batteries-included `browserTool`/`containerTool` dispatch to. Codegen
 * auto-registers it at `sandbox:invoke` whenever `lunora/` imports a sandbox
 * tool. It runs as an **action** because that is the only ctx codegen attaches
 * `ctx.browser` to (and `ctx.containers` rides every ctx once a container is
 * declared) — the durable tool step itself has neither.
 */
const sandboxComponent = (): SandboxComponent => {
    const invoke = internalAction
        .input({
            args: v.optional(v.array(v.string())),
            body: v.optional(v.string()),
            command: v.optional(v.string()),
            fullPage: v.optional(v.boolean()),
            kind: v.union(v.literal("browser"), v.literal("container")),
            method: v.optional(v.string()),
            name: v.optional(v.string()),
            op: v.string(),
            path: v.optional(v.string()),
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

export type { SandboxComponent, SandboxRegisteredFunction };
export { sandboxComponent };
