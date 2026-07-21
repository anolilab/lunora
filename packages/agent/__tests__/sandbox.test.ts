import { describe, expect, it, vi } from "vitest";

import { sandboxComponent } from "../src/component";
import { SANDBOX_INVOKE_PATH } from "../src/paths";
import { browserTool, containerTool } from "../src/sandbox";
import type { AgentToolContext } from "../src/types";

const EMPTY_NAME_ERROR = /requires a container `name`/u;
const MISSING_BROWSER_ERROR = /needs `ctx\.browser`/u;
const UNKNOWN_CONTAINER_ERROR = /no ctx\.containers\["missing"\]/u;
const NO_FS_BUCKET_ERROR = /found no R2 bucket/u;

/** A tool `execute` context whose `run` records the dispatched (ref, args). */
const recordingContext = (): { calls: { args: unknown; ref: unknown }[]; context: AgentToolContext } => {
    const calls: { args: unknown; ref: unknown }[] = [];

    return {
        calls,
        context: {
            env: {},
            getState: async () => undefined,
            idempotencyKey: "tool:x:call-1",
            reportProgress: () => {},
            run: async (ref: unknown, args: unknown) => {
                calls.push({ args, ref });

                return "ok";
            },
            setState: async () => {},
            threadKey: "t-1",
            toolCallId: "call-1",
        },
    };
};

/** Invoke the registered sandbox action's handler directly with a fake action ctx. */
const invokeSandbox = async (ctx: unknown, args: Record<string, unknown>): Promise<unknown> => {
    const { invoke } = sandboxComponent();

    return (invoke.handler as (context: unknown, args: never) => Promise<unknown>)(ctx, args as never);
};

describe(browserTool, () => {
    it("returns one well-formed agent tool with no approval gate", () => {
        const tool = browserTool();

        expect(tool.isLunoraAgentTool).toBe(true);
        expect(tool.description).toBeTypeOf("string");
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.inputSchema).toBeDefined();
        expect(tool.needsApproval).toBeUndefined();
    });

    it("dispatches to sandbox:invoke with a browser-kind payload", async () => {
        const tool = browserTool();
        const { calls, context } = recordingContext();

        await tool.execute({ fullPage: true, op: "screenshot", url: "https://example.com" }, context);

        expect(calls).toHaveLength(1);
        expect(calls[0]?.ref).toStrictEqual({ __lunoraRef: SANDBOX_INVOKE_PATH });
        expect(calls[0]?.args).toStrictEqual({ fullPage: true, kind: "browser", op: "screenshot", url: "https://example.com" });
    });

    it("honors a custom description", () => {
        expect(browserTool({ description: "Custom" }).description).toBe("Custom");
    });

    it("gates behind approval when opts.needsApproval is supplied (unattended SSRF surface)", () => {
        expect(browserTool({ needsApproval: true }).needsApproval).toBe(true);

        const gated = browserTool({ needsApproval: (input) => input.op === "screenshot" });

        expect((gated.needsApproval as (input: { op: string }) => boolean)({ op: "screenshot" })).toBe(true);
        expect((gated.needsApproval as (input: { op: string }) => boolean)({ op: "content" })).toBe(false);
    });

    it("pins kind LAST so out-of-schema model input cannot override it", async () => {
        const tool = browserTool();
        const { calls, context } = recordingContext();

        // A prompt-injected model emits an out-of-schema `kind` to reroute the call.
        await tool.execute({ kind: "container", op: "content", url: "https://evil" } as never, context);

        expect((calls[0]?.args as { kind: string }).kind).toBe("browser");
    });
});

describe(containerTool, () => {
    it("throws on an empty container name", () => {
        expect(() => containerTool("")).toThrow(EMPTY_NAME_ERROR);
    });

    it("gates EXEC by default and passes a method-omitted (GET) fetch through", () => {
        const tool = containerTool("sandbox");

        expect(tool.needsApproval).toBeTypeOf("function");

        const needsApproval = tool.needsApproval as (input: { op: string }) => boolean;

        expect(needsApproval({ op: "exec" })).toBe(true);
        // No `method` ⇒ defaults to GET (idempotent) ⇒ unattended.
        expect(needsApproval({ op: "fetch" })).toBe(false);
    });

    it("lets opts.needsApproval override the default gate", () => {
        expect(containerTool("sandbox", { needsApproval: true }).needsApproval).toBe(true);
        expect(containerTool("sandbox", { needsApproval: false }).needsApproval).toBe(false);

        const always = containerTool("sandbox", { needsApproval: () => true });

        expect((always.needsApproval as (input: { op: string }) => boolean)({ op: "fetch" })).toBe(true);
    });

    it("gates a fetch whose path resolves to the privileged /exec route", () => {
        const needsApproval = containerTool("sandbox").needsApproval as (input: { op: string; path?: string }) => boolean;

        // A fetch to /exec reaches the same command path as an exec, so it must gate.
        expect(needsApproval({ op: "fetch", path: "/exec" })).toBe(true);
        expect(needsApproval({ op: "fetch", path: "exec" })).toBe(true);
        expect(needsApproval({ op: "fetch", path: "//exec" })).toBe(true);
        expect(needsApproval({ op: "fetch", path: "/./exec" })).toBe(true);
        expect(needsApproval({ op: "fetch", path: "/foo/../exec" })).toBe(true);
        expect(needsApproval({ op: "fetch", path: "/exec?x=1" })).toBe(true);
        // A GET fetch to any other route stays unattended.
        expect(needsApproval({ op: "fetch", path: "/health" })).toBe(false);
        expect(needsApproval({ op: "fetch", path: "/execute" })).toBe(false);
    });

    it("gates a fetch using a non-idempotent method, even off the /exec route", () => {
        const needsApproval = containerTool("sandbox").needsApproval as (input: { method?: string; op: string; path?: string }) => boolean;

        // A prompt-injected model could otherwise mutate container state
        // through some OTHER privileged route just by avoiding `/exec`.
        expect(needsApproval({ method: "POST", op: "fetch", path: "/health" })).toBe(true);
        expect(needsApproval({ method: "PUT", op: "fetch", path: "/config" })).toBe(true);
        expect(needsApproval({ method: "PATCH", op: "fetch", path: "/config" })).toBe(true);
        expect(needsApproval({ method: "DELETE", op: "fetch", path: "/data" })).toBe(true);
        // Case-insensitive.
        expect(needsApproval({ method: "post", op: "fetch", path: "/health" })).toBe(true);

        // Read-only methods (and an omitted method, defaulting to GET) stay unattended.
        expect(needsApproval({ method: "GET", op: "fetch", path: "/health" })).toBe(false);
        expect(needsApproval({ method: "HEAD", op: "fetch", path: "/health" })).toBe(false);
        expect(needsApproval({ method: "OPTIONS", op: "fetch", path: "/health" })).toBe(false);
        expect(needsApproval({ op: "fetch", path: "/health" })).toBe(false);
    });

    it("dispatches to sandbox:invoke with a container-kind payload carrying the name", async () => {
        const tool = containerTool("sandbox");
        const { calls, context } = recordingContext();

        await tool.execute({ op: "fetch", path: "/health" }, context);

        expect(calls[0]?.ref).toStrictEqual({ __lunoraRef: SANDBOX_INVOKE_PATH });
        expect(calls[0]?.args).toStrictEqual({ kind: "container", name: "sandbox", op: "fetch", path: "/health" });
    });

    it("pins name/kind LAST so a model cannot reroute to another container", async () => {
        const tool = containerTool("public");
        const { calls, context } = recordingContext();

        // A prompt-injected model emits an out-of-schema `name` to reach another container.
        await tool.execute({ name: "internal", op: "fetch", path: "/admin" } as never, context);

        expect(calls[0]?.args).toStrictEqual({ kind: "container", name: "public", op: "fetch", path: "/admin" });
    });
});

describe("sandboxComponent().invoke", () => {
    it("is an internal action", () => {
        const { invoke } = sandboxComponent();

        expect(invoke.kind).toBe("action");
        expect(invoke.visibility).toBe("internal");
    });

    it("routes a browser screenshot to ctx.browser and base64-encodes the bytes", async () => {
        const screenshot = vi.fn<(url: string, options: Record<string, unknown>) => Promise<Uint8Array>>(async () => new Uint8Array([1, 2, 3]));
        const result = await invokeSandbox({ browser: { screenshot } }, { kind: "browser", op: "screenshot", url: "https://example.com" });

        expect(screenshot).toHaveBeenCalledWith("https://example.com", {});
        // base64("\x01\x02\x03") === "AQID" — deterministic, no Date.now/Math.random.
        expect(result).toStrictEqual({ data: "AQID", encoding: "base64", mediaType: "image/png" });
    });

    it("routes a browser content op to ctx.browser.content as a plain string", async () => {
        const content = vi.fn<(url: string) => Promise<string>>(async () => "<html></html>");
        const result = await invokeSandbox({ browser: { content } }, { kind: "browser", op: "content", url: "https://example.com" });

        expect(result).toBe("<html></html>");
    });

    it("errors when a browser op has no ctx.browser", async () => {
        await expect(invokeSandbox({}, { kind: "browser", op: "content", url: "https://x" })).rejects.toThrow(MISSING_BROWSER_ERROR);
    });

    it("routes a container fetch through ctx.containers[name].any().fetch", async () => {
        const fetch = vi.fn<(path: string, init: Record<string, unknown>) => Promise<{ text: () => Promise<string> }>>(async () => {
            return { text: async () => "pong" };
        });
        const containers = {
            sandbox: {
                any: () => {
                    return { fetch };
                },
            },
        };
        const result = await invokeSandbox({ containers }, { kind: "container", method: "GET", name: "sandbox", op: "fetch", path: "/ping" });

        expect(fetch).toHaveBeenCalledWith("/ping", { method: "GET" });
        expect(result).toBe("pong");
    });

    it("routes a container exec as a POST to /exec", async () => {
        const fetch = vi.fn<(path: string, init: Record<string, unknown>) => Promise<{ text: () => Promise<string> }>>(async () => {
            return { text: async () => "done" };
        });
        const containers = {
            sandbox: {
                any: () => {
                    return { fetch };
                },
            },
        };
        const result = await invokeSandbox({ containers }, { args: ["-la"], command: "ls", kind: "container", name: "sandbox", op: "exec" });

        expect(fetch).toHaveBeenCalledWith("/exec", {
            body: JSON.stringify({ args: ["-la"], command: "ls" }),
            headers: { "content-type": "application/json" },
            method: "POST",
        });
        expect(result).toBe("done");
    });

    it("errors when a container op names an unknown container", async () => {
        await expect(invokeSandbox({ containers: {} }, { kind: "container", name: "missing", op: "fetch", path: "/" })).rejects.toThrow(
            UNKNOWN_CONTAINER_ERROR,
        );
    });

    it("routes a fs op to the R2 bucket resolved from ctx.env[bucket]", async () => {
        const store = new Map<string, string>();
        const bucket = {
            delete: async (key: string) => {
                store.delete(key);
            },
            get: async (key: string) => (store.has(key) ? { text: async () => store.get(key) ?? "" } : null),
            head: async () => null,
            list: async () => {
                return { objects: [] };
            },
            put: async (key: string, value: string) => {
                store.set(key, value);
            },
        };

        const wrote = await invokeSandbox(
            { env: { SANDBOX_BUCKET: bucket } },
            { bucket: "SANDBOX_BUCKET", content: "hi", kind: "fs", op: "write", path: "a.txt", root: "agents/x" },
        );

        expect(wrote).toStrictEqual({ bytes: 2, path: "a.txt", wrote: true });
        expect(store.get("agents/x/a.txt")).toBe("hi");
    });

    it("errors when a fs op finds no R2 bucket on env", async () => {
        await expect(invokeSandbox({ env: {} }, { bucket: "MISSING", kind: "fs", op: "ls", root: "" })).rejects.toThrow(NO_FS_BUCKET_ERROR);
    });
});
