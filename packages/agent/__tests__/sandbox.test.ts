import type { ContainerHandle } from "@lunora/container";
import { CONTAINER_EXEC_PATH, createContainerTestContext } from "@lunora/container";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { sandboxComponent } from "../src/component";
import { SANDBOX_INVOKE_PATH } from "../src/paths";
import { browserTool, containerTool } from "../src/sandbox";
import type { SandboxContainerAccessor } from "../src/sandbox-component";
import type { AgentToolContext } from "../src/types";

const EMPTY_NAME_ERROR = /requires a container `name`/u;
const MISSING_BROWSER_ERROR = /needs `ctx\.browser`/u;
const UNKNOWN_CONTAINER_ERROR = /no ctx\.containers\["missing"\]/u;
const NO_FS_BUCKET_ERROR = /found no R2 bucket/u;
const RESERVED_ROUTE_ERROR = /reserved for Lunora's own container routes/u;

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

    it("cannot reach the exec route with a fetch at all", async () => {
        expect.assertions(3);

        // The gate does not pattern-match the exec route, because a `fetch`
        // never arrives there: `@lunora/container` reserves `/__lunora/*` at the
        // handle, which is the only place that resolves the path the same way
        // the container's router will. Assert the refusal rather than trusting
        // it — this is what makes a second copy of the route literal (and the
        // spelling-guessing that came with it) unnecessary here.
        const accessor: SandboxContainerAccessor = createContainerTestContext({ box: () => new Response("ok") }).box!;

        await expect(accessor.any().fetch(CONTAINER_EXEC_PATH)).rejects.toThrow(RESERVED_ROUTE_ERROR);
        await expect(accessor.any().fetch("/foo/../__lunora/exec")).rejects.toThrow(RESERVED_ROUTE_ERROR);
        await expect(accessor.any().fetch("/health")).resolves.toBeInstanceOf(Response);
    });

    it("keeps the structural container accessor a subset of the real one", () => {
        // `SandboxContainerAccessor` re-declares `exec`/`fetch` by hand so the
        // component module stays free of a runtime import. Hand-copied
        // structural mirrors drift — this is what notices when they do, in the
        // types AND at runtime, since `handle.exec` only exists in
        // `@lunora/container` from the version the peer range names.
        expectTypeOf<ContainerHandle>().toExtend<ReturnType<SandboxContainerAccessor["any"]>>();

        const accessor: SandboxContainerAccessor = createContainerTestContext({ box: () => new Response("ok") }).box!;

        expect(accessor.any().exec).toBeTypeOf("function");
    });

    it("never throws out of the gate on a malformed or non-string path", () => {
        const needsApproval = containerTool("sandbox").needsApproval as (input: { method?: string; op: string; path?: unknown }) => boolean;

        // A gate that throws fails OPEN — the exception escapes the policy and
        // leaves the caller deciding what an errored approval check means. Model
        // tool input reaches here unvalidated (`CONTAINER_TOOL_SCHEMA` carries no
        // `validate`), so `path` can be anything at all.
        expect(needsApproval({ op: "fetch", path: "/100%" })).toBe(false);
        expect(needsApproval({ op: "fetch", path: null })).toBe(false);
        expect(needsApproval({ op: "fetch", path: 42 })).toBe(false);
        expect(needsApproval({ method: "POST", op: "fetch", path: "/%zz" })).toBe(true);
    });

    it("gates a fetch using a non-idempotent method", () => {
        const needsApproval = containerTool("sandbox").needsApproval as (input: { method?: string; op: string; path?: string }) => boolean;

        // A prompt-injected model could otherwise mutate container state
        // through some other privileged/mutating route on the container.
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

    it("delegates a container exec to ctx.containers.<name>.exec", async () => {
        const exec = vi.fn<() => Promise<{ code: number; stderr: string; stdout: string }>>(async () => {
            return { code: 0, stderr: "", stdout: "done" };
        });
        const containers = {
            sandbox: {
                any: () => {
                    return { exec, fetch: vi.fn<() => Promise<never>>() };
                },
            },
        };
        const result = await invokeSandbox({ containers }, { args: ["-la"], command: "ls", kind: "container", name: "sandbox", op: "exec" });

        // The wire format is @lunora/container's contract now, not this module's.
        expect(exec).toHaveBeenCalledWith("ls", { args: ["-la"] });
        expect(result).toBe("exit code: 0\n\nstdout:\ndone");
    });

    it("reports a failed command's exit code and stderr to the model", async () => {
        const exec = vi.fn<() => Promise<{ code: number; stderr: string; stdout: string }>>(async () => {
            return { code: 2, stderr: "no such file\n", stdout: "" };
        });
        const containers = {
            sandbox: {
                any: () => {
                    return { exec, fetch: vi.fn<() => Promise<never>>() };
                },
            },
        };

        // The regression this contract exists for: before E2 the tool read the raw
        // response body back as output, so a failed command — or a container with
        // no exec route — was indistinguishable from a successful one.
        const result = await invokeSandbox({ containers }, { command: "cat", kind: "container", name: "sandbox", op: "exec" });

        expect(result).toBe("exit code: 2\n\nstderr:\nno such file\n");
    });

    it("states the exit code even when a command produced no output", async () => {
        const exec = vi.fn<() => Promise<{ code: number; stderr: string; stdout: string }>>(async () => {
            return { code: 0, stderr: "", stdout: "" };
        });
        const containers = {
            sandbox: {
                any: () => {
                    return { exec, fetch: vi.fn<() => Promise<never>>() };
                },
            },
        };

        // "ran, produced nothing" must be distinguishable from "did not run".
        await expect(invokeSandbox({ containers }, { command: "true", kind: "container", name: "sandbox", op: "exec" })).resolves.toBe("exit code: 0");
    });

    it("renders a thrown exec failure instead of rethrowing it", async () => {
        const exec = vi.fn<() => Promise<never>>(async () => {
            throw new Error("ctx.containers.sandbox: exec failed — the container answered 500 for POST /__lunora/exec");
        });
        const containers = {
            sandbox: {
                any: () => {
                    return { exec, fetch: vi.fn<() => Promise<never>>() };
                },
            },
        };

        // A tool call runs inside `step.do`, which RETRIES a step that throws.
        // `exec` throws on outcomes that occur after the command already ran —
        // the runner crashing while serialising the result, or output past the
        // cap — so rethrowing would re-execute an approved `pnpm publish`. The
        // step has to complete, with the failure as its value.
        await expect(invokeSandbox({ containers }, { command: "pnpm", kind: "container", name: "sandbox", op: "exec" })).resolves.toBe(
            "exec failed: ctx.containers.sandbox: exec failed — the container answered 500 for POST /__lunora/exec",
        );
        expect(exec).toHaveBeenCalledTimes(1);
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
