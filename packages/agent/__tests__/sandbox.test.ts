import type { ContainerHandle } from "@lunora/container";
import { CONTAINER_EXEC_PATH, createContainerTestContext } from "@lunora/container";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { sandboxComponent } from "../src/component";
import { SANDBOX_INVOKE_PATH } from "../src/paths";
import type { BrowserRenderResult } from "../src/sandbox";
import { browserTool, containerTool } from "../src/sandbox";
import {
    SANDBOX_BROWSER_DISPATCH_TIMEOUT_MS,
    SANDBOX_BROWSER_NAV_TIMEOUT_MS,
    SANDBOX_CONTAINER_DISPATCH_TIMEOUT_MS,
    SANDBOX_EXEC_TIMEOUT_MS,
} from "../src/sandbox-budgets";
import type { SandboxContainerAccessor } from "../src/sandbox-component";
import type { AgentToolContext } from "../src/types";
import { passthroughStep } from "./loop-harness";

const EMPTY_NAME_ERROR = /requires a container `name`/u;
const MISSING_BROWSER_ERROR = /needs `ctx\.browser`/u;
const UNKNOWN_CONTAINER_ERROR = /no ctx\.containers\["missing"\]/u;
const NO_FS_BUCKET_ERROR = /found no R2 bucket/u;
const RESERVED_ROUTE_ERROR = /reserved for Lunora's own container routes/u;
const NO_RENDER_BUCKET_HINT = /bucket/u;
const TRUNCATION_HINT = /truncated/u;
const NO_INSTANCE_ERROR = /arrived with no `instance`/u;

/** A tool `execute` context whose `run` records the dispatched (ref, args, options). */
const recordingContext = (): { calls: { args: unknown; options: unknown; ref: unknown }[]; context: AgentToolContext } => {
    const calls: { args: unknown; options: unknown; ref: unknown }[] = [];

    return {
        calls,
        context: {
            env: {},
            getState: async () => undefined,
            idempotencyKey: "tool:x:call-1",
            reportProgress: () => {},
            run: async (ref: unknown, args: unknown, options: unknown) => {
                calls.push({ args, options, ref });

                return "ok";
            },
            setState: async () => {},
            step: passthroughStep,
            threadKey: "t-1",
            toolCallId: "call-1",
        },
    };
};

/** An in-memory `R2BucketLike` double — the fs ops and the browser render destination share it. */
const memoryBucket = (): { bucket: Record<string, unknown>; store: Map<string, unknown> } => {
    const store = new Map<string, unknown>();

    return {
        bucket: {
            delete: async (key: string) => {
                store.delete(key);
            },
            get: async (key: string) => (store.has(key) ? { text: async () => (store.get(key) as string | undefined) ?? "" } : null),
            head: async () => null,
            list: async () => {
                return { objects: [] };
            },
            put: async (key: string, value: unknown) => {
                store.set(key, value);
            },
        },
        store,
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
        const tool = browserTool({ bucket: "SHOTS" });
        const { calls, context } = recordingContext();

        await tool.execute({ fullPage: true, op: "screenshot", url: "https://example.com" }, context);

        expect(calls).toHaveLength(1);
        expect(calls[0]?.ref).toStrictEqual({ __lunoraRef: SANDBOX_INVOKE_PATH });
        expect(calls[0]?.args).toStrictEqual({
            bucket: "SHOTS",
            fullPage: true,
            kind: "browser",
            op: "screenshot",
            path: "t-1/call-1.png",
            url: "https://example.com",
        });
    });

    it("honors a custom description", () => {
        expect(browserTool({ description: "Custom" }).description).toBe("Custom");
    });

    it("carries a dispatch budget wider than the runner's 30s default", async () => {
        const tool = browserTool();
        const { calls, context } = recordingContext();

        await tool.execute({ op: "content", url: "https://example.com" }, context);

        // Without this the dispatch dies at DEFAULT_DISPATCH_TIMEOUT_MS (30s)
        // with the navigation still running, the step retries, and the page is
        // fetched a second time.
        expect(calls[0]?.options).toStrictEqual({ timeoutMs: SANDBOX_BROWSER_DISPATCH_TIMEOUT_MS });
        expect(SANDBOX_BROWSER_DISPATCH_TIMEOUT_MS).toBeGreaterThan(SANDBOX_BROWSER_NAV_TIMEOUT_MS);
    });

    it("pins the render destination so screenshot/pdf bytes survive the tool-output cap", async () => {
        const tool = browserTool({ bucket: "SHOTS", root: "renders" });
        const { calls, context } = recordingContext();

        await tool.execute({ op: "screenshot", url: "https://example.com" }, context);

        // The bytes go to R2 under a replay-stable key; base64 in the tool
        // result would be truncated to 4000 chars and unusable.
        expect(calls[0]?.args).toStrictEqual({
            bucket: "SHOTS",
            kind: "browser",
            op: "screenshot",
            path: "t-1/call-1.png",
            root: "renders",
            url: "https://example.com",
        });
    });

    it("refuses a render with no bucket instead of billing one the model cannot read", async () => {
        const tool = browserTool();
        const { calls, context } = recordingContext();

        const result = await tool.execute({ op: "pdf", url: "https://example.com" }, context);

        expect(calls).toHaveLength(0);
        expect(result).toMatch(NO_RENDER_BUCKET_HINT);
    });

    it("keys a jpeg screenshot .jpeg, so the extension cannot contradict the bytes", async () => {
        const tool = browserTool({ bucket: "SHOTS" });
        const { calls, context } = recordingContext();

        await tool.execute({ op: "screenshot", type: "jpeg", url: "https://example.com" }, context);

        // The component stores this render as `image/jpeg`. A fixed `.png` key
        // would disagree with its own media type, and anything that infers the
        // format from the key — a CDN, a thumbnailer, a browser opening the
        // object — reads it wrong.
        expect(calls[0]?.args).toMatchObject({ path: "t-1/call-1.jpeg" });
    });

    it("declares the render metadata in its result type, not just `string`", async () => {
        const tool = browserTool({ bucket: "SHOTS" });
        const { context } = recordingContext();

        const result = await tool.execute({ op: "screenshot", url: "https://example.com" }, context);

        // A render op resolves to `{ bytes, key, mediaType }`, and while
        // `execute` declared `string` an external caller had no such branch to
        // narrow into: `result.toUpperCase()` compiled and failed at runtime.
        //
        // Asserted with `expectTypeOf`, NOT by narrowing on `typeof` and reading
        // `.key` — under a regressed `string` the object branch is `never`, and
        // TypeScript accepts any property access on `never`. That check passes
        // either way and proves nothing.
        expectTypeOf(result).toEqualTypeOf<BrowserRenderResult | string>();

        expect(result).toBe("ok");
    });

    it('treats an empty bucket as unconfigured, not as a binding named ""', async () => {
        const tool = browserTool({ bucket: "" });
        const { calls, context } = recordingContext();

        const result = await tool.execute({ op: "pdf", url: "https://example.com" }, context);

        // Dispatched, `resolveBucket` would look up `env[""]`, find nothing and
        // throw INTERNAL — which is RETRYABLE, so the run burns its whole retry
        // budget and fails instead of returning this directed refusal.
        expect(calls).toHaveLength(0);
        expect(result).toMatch(NO_RENDER_BUCKET_HINT);
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

    it("strips a model-supplied render destination on EVERY op, not just the two that read it", async () => {
        const tool = browserTool({ bucket: "SHOTS", root: "renders" });
        const { calls, context } = recordingContext();

        // `content` ignores the destination today, so a model-named `bucket`
        // would only make the dispatcher resolve that env binding — inert, but
        // the author owns the destination for every op or for none.
        await tool.execute({ bucket: "SECRETS", op: "content", path: "../etc", root: "/" } as never, context);

        expect(calls[0]?.args).toStrictEqual({ kind: "browser", op: "content" });

        // And on a render op the author's destination wins outright.
        await tool.execute({ bucket: "SECRETS", op: "screenshot", path: "../etc", root: "/", url: "https://x" } as never, context);

        expect(calls[1]?.args).toStrictEqual({
            bucket: "SHOTS",
            kind: "browser",
            op: "screenshot",
            path: "t-1/call-1.png",
            root: "renders",
            url: "https://x",
        });
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
        expect(calls[0]?.args).toStrictEqual({ instance: "t-1", kind: "container", name: "sandbox", op: "fetch", path: "/health" });
    });

    it("forwards no idempotencyKey — the receiver declares none and has nothing to dedupe against", async () => {
        const tool = containerTool("sandbox");
        const { calls, context } = recordingContext();

        await tool.execute({ command: "deploy", op: "exec" }, context);

        // Deliberate, and the opposite of `functionTool`, which pins
        // `context.idempotencyKey` onto the args for a target that can declare
        // `idempotencyKey` in its own validator and check it. `sandbox:invoke`
        // declares no such arg — an undeclared arg field is DROPPED by the
        // validator, not rejected — and an action ctx has nowhere to record a
        // key even if it read one. Forwarding it would advertise a dedupe that
        // nothing performs; an exec that cannot afford to run twice has to be
        // idempotent itself. See `sandbox-component.ts`.
        expect(calls[0]?.args).toStrictEqual({ command: "deploy", instance: "t-1", kind: "container", name: "sandbox", op: "exec" });
        expect(context.idempotencyKey).toBe("tool:x:call-1");
    });

    it("pins a thread-derived instance so consecutive execs share one disk", async () => {
        const tool = containerTool("sandbox");
        const { calls, context } = recordingContext();

        await tool.execute({ command: "pnpm", op: "exec" }, context);

        // `.any()` re-picks a RANDOM pool instance per call, so `pnpm install`
        // then `pnpm test` land on different containers with fresh disks.
        expect((calls[0]?.args as { instance?: string }).instance).toBe("t-1");
        expect(calls[0]?.options).toStrictEqual({ timeoutMs: SANDBOX_CONTAINER_DISPATCH_TIMEOUT_MS });
        expect(SANDBOX_CONTAINER_DISPATCH_TIMEOUT_MS).toBeGreaterThan(SANDBOX_EXEC_TIMEOUT_MS);
    });

    it("pins name/kind LAST so a model cannot reroute to another container", async () => {
        const tool = containerTool("public");
        const { calls, context } = recordingContext();

        // A prompt-injected model emits an out-of-schema `name` to reach another container.
        await tool.execute({ name: "internal", op: "fetch", path: "/admin" } as never, context);

        expect(calls[0]?.args).toStrictEqual({ instance: "t-1", kind: "container", name: "public", op: "fetch", path: "/admin" });
    });
});

describe("sandboxComponent().invoke", () => {
    it("is an internal action", () => {
        const { invoke } = sandboxComponent();

        expect(invoke.kind).toBe("action");
        expect(invoke.visibility).toBe("internal");
    });

    it("stores a browser screenshot in R2 and returns its key, never inline bytes", async () => {
        const screenshot = vi.fn<(url: string, options: Record<string, unknown>) => Promise<Uint8Array>>(async () => new Uint8Array([1, 2, 3]));
        const { bucket, store } = memoryBucket();
        const result = await invokeSandbox(
            { browser: { screenshot }, env: { SHOTS: bucket } },
            { bucket: "SHOTS", kind: "browser", op: "screenshot", path: "t-1/call-1.png", root: "renders", url: "https://example.com" },
        );

        // A 20KB PNG is ~26KB of base64 — `capToolOutputText` cuts the result at
        // 4000 chars, so an inline-bytes render is billed and then thrown away.
        expect(result).toStrictEqual({ bytes: 3, key: "renders/t-1/call-1.png", mediaType: "image/png" });
        expect(store.has("renders/t-1/call-1.png")).toBe(true);
        expect(screenshot).toHaveBeenCalledWith("https://example.com", { timeoutMs: SANDBOX_BROWSER_NAV_TIMEOUT_MS });
    });

    // BOTH byte-returning ops, not just one: the ordering is easy to get right by
    // accident in `pdf` (the bucket is an argument, evaluated before the awaited
    // render) and easy to get wrong in `screenshot`, where the render is awaited
    // into a local first. A one-op version of this test passed against a
    // screenshot branch that billed the render and only then looked for a bucket.
    it.each(["pdf", "screenshot"])("refuses a browser %s when its bucket is absent, before the render is billed", async (op) => {
        const render = vi.fn<() => Promise<Uint8Array>>(async () => new Uint8Array([1]));

        await expect(
            invokeSandbox(
                { browser: { pdf: render, screenshot: render }, env: {} },
                { bucket: "GONE", kind: "browser", op, path: `a.${op}`, url: "https://x" },
            ),
        ).rejects.toThrow(NO_FS_BUCKET_ERROR);
        expect(render).not.toHaveBeenCalled();
    });

    it("routes a browser content op to ctx.browser.content as a plain string", async () => {
        const content = vi.fn<(url: string) => Promise<string>>(async () => "<html></html>");
        const result = await invokeSandbox({ browser: { content } }, { kind: "browser", op: "content", url: "https://example.com" });

        expect(result).toBe("<html></html>");
    });

    // EVERY op, not just the render pair. The inner deadline is what makes the
    // dispatch budget's `inner < dispatch` invariant real: an op left on the
    // app's own `createBrowser` default (30s, or whatever the app configured)
    // is not provably tighter than the 150s dispatch, so a slow page could
    // outlive the dispatch, 503, and have the step re-run the navigation. The
    // `screenshot` assertion above covered one of four.
    it.each(["content", "pdf", "scrape", "screenshot"])("pins the inner navigation budget on a browser %s, not just the render pair", async (op) => {
        const render = vi.fn<() => Promise<Uint8Array>>(async () => new Uint8Array([1]));
        const browser = {
            content: vi.fn<() => Promise<string>>(async () => ""),
            pdf: render,
            scrape: vi.fn<() => Promise<string>>(async () => ""),
            screenshot: render,
        };
        const { bucket } = memoryBucket();

        await invokeSandbox({ browser, env: { SHOTS: bucket } }, { bucket: "SHOTS", kind: "browser", op, path: `a.${op}`, url: "https://example.com" });

        // `scrape` takes the extractor between the url and the options, so the
        // budget is the LAST argument on every op rather than a fixed index.
        const call = browser[op as keyof typeof browser].mock.calls[0] as unknown[];

        expect(call.at(-1)).toMatchObject({ timeoutMs: SANDBOX_BROWSER_NAV_TIMEOUT_MS });
        expect(SANDBOX_BROWSER_DISPATCH_TIMEOUT_MS).toBeGreaterThan(SANDBOX_BROWSER_NAV_TIMEOUT_MS);
    });

    it("errors when a browser op has no ctx.browser", async () => {
        await expect(invokeSandbox({}, { kind: "browser", op: "content", url: "https://x" })).rejects.toThrow(MISSING_BROWSER_ERROR);
    });

    it("routes a container fetch through the pinned instance, not a random pool pick", async () => {
        const fetch = vi.fn<(path: string, init: Record<string, unknown>) => Promise<Response>>(async () => new Response("pong"));
        const get = vi.fn<(name: string) => { exec: unknown; fetch: unknown }>((_name: string) => {
            return { exec: vi.fn<() => Promise<never>>(), fetch };
        });
        const containers = {
            sandbox: {
                any: () => {
                    throw new Error("must not reach .any()");
                },
                get,
            },
        };
        const result = await invokeSandbox({ containers }, { instance: "t-1", kind: "container", method: "GET", name: "sandbox", op: "fetch", path: "/ping" });

        expect(get).toHaveBeenCalledWith("t-1");
        expect(fetch.mock.calls[0]?.[0]).toBe("/ping");
        expect(result).toBe("pong");
    });

    it("caps a container fetch body instead of buffering it whole", async () => {
        // `exec` already refuses an unbounded body for this exact reason: the
        // whole thing is held in a 128MB isolate shared with every other
        // in-flight request. `response.text()` on a fetch had no such bound.
        const huge = "x".repeat(8 * 1024 * 1024);
        const fetch = vi.fn<() => Promise<Response>>(async () => new Response(huge));
        const containers = {
            sandbox: {
                any: () => {
                    throw new Error("must not reach .any()");
                },
                get: () => {
                    return { exec: vi.fn<() => Promise<never>>(), fetch };
                },
            },
        };
        const result = (await invokeSandbox({ containers }, { instance: "t-1", kind: "container", name: "sandbox", op: "fetch", path: "/big" })) as string;

        expect(result.length).toBeLessThan(huge.length);
        expect(result).toMatch(TRUNCATION_HINT);
    });

    it("bounds a container fetch in TIME as well as bytes, on both the request and the body read", async () => {
        // `exec` has had an inner deadline since it shipped; `fetch` had none, so
        // a request that outlived the 150s dispatch budget let the step retry
        // re-issue an approved mutating request while the first was still in
        // flight. `readCapped` bounds the BYTES; only a signal bounds the WAIT.
        let requestSignal: AbortSignal | undefined;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("ok"));
                controller.close();
            },
        });
        const fetch = vi.fn<(input: string, init?: { signal?: AbortSignal }) => Promise<Response>>(async (_input, init) => {
            requestSignal = init?.signal;

            return new Response(body);
        });
        const containers = {
            sandbox: {
                any: () => {
                    throw new Error("must not reach .any()");
                },
                get: () => {
                    return { exec: vi.fn<() => Promise<never>>(), fetch };
                },
            },
        };

        await invokeSandbox({ containers }, { instance: "t-1", kind: "container", name: "sandbox", op: "fetch", path: "/slow" });

        // What this pins is that a deadline EXISTS and reaches the request; the
        // same signal is handed to the body read, which nothing here observes
        // (`readCapped` is bundler-inlined, not injected).
        expect(requestSignal).toBeInstanceOf(AbortSignal);
        expect(requestSignal?.aborted).toBe(false);
    });

    it("delegates a container exec to ctx.containers.<name>.exec", async () => {
        const exec = vi.fn<() => Promise<{ code: number; stderr: string; stdout: string }>>(async () => {
            return { code: 0, stderr: "", stdout: "done" };
        });
        const containers = {
            sandbox: {
                any: () => {
                    throw new Error("must not reach .any()");
                },
                get: () => {
                    return { exec, fetch: vi.fn<() => Promise<never>>() };
                },
            },
        };
        const result = await invokeSandbox({ containers }, { args: ["-la"], command: "ls", instance: "t-1", kind: "container", name: "sandbox", op: "exec" });

        // The wire format is @lunora/container's contract now, not this module's.
        // The inner budget is strictly under the dispatch budget the tool asked
        // for, so the CONTAINER kills the command rather than the dispatch
        // abandoning it mid-run for the step to re-execute.
        expect(exec).toHaveBeenCalledWith("ls", { args: ["-la"], timeoutMs: SANDBOX_EXEC_TIMEOUT_MS });
        expect(result).toBe("exit code: 0\n\nstdout:\ndone");
    });

    it("reports a failed command's exit code and stderr to the model", async () => {
        const exec = vi.fn<() => Promise<{ code: number; stderr: string; stdout: string }>>(async () => {
            return { code: 2, stderr: "no such file\n", stdout: "" };
        });
        const containers = {
            sandbox: {
                any: () => {
                    throw new Error("must not reach .any()");
                },
                get: () => {
                    return { exec, fetch: vi.fn<() => Promise<never>>() };
                },
            },
        };

        // The regression this contract exists for: before E2 the tool read the raw
        // response body back as output, so a failed command — or a container with
        // no exec route — was indistinguishable from a successful one.
        const result = await invokeSandbox({ containers }, { command: "cat", instance: "t-1", kind: "container", name: "sandbox", op: "exec" });

        expect(result).toBe("exit code: 2\n\nstderr:\nno such file\n");
    });

    it("states the exit code even when a command produced no output", async () => {
        const exec = vi.fn<() => Promise<{ code: number; stderr: string; stdout: string }>>(async () => {
            return { code: 0, stderr: "", stdout: "" };
        });
        const containers = {
            sandbox: {
                any: () => {
                    throw new Error("must not reach .any()");
                },
                get: () => {
                    return { exec, fetch: vi.fn<() => Promise<never>>() };
                },
            },
        };

        // "ran, produced nothing" must be distinguishable from "did not run".
        await expect(invokeSandbox({ containers }, { command: "true", instance: "t-1", kind: "container", name: "sandbox", op: "exec" })).resolves.toBe(
            "exit code: 0",
        );
    });

    it("renders a thrown exec failure instead of rethrowing it", async () => {
        const exec = vi.fn<() => Promise<never>>(async () => {
            throw new Error("ctx.containers.sandbox: exec failed — the container answered 500 for POST /__lunora/exec");
        });
        const containers = {
            sandbox: {
                any: () => {
                    throw new Error("must not reach .any()");
                },
                get: () => {
                    return { exec, fetch: vi.fn<() => Promise<never>>() };
                },
            },
        };

        // A tool call runs inside `step.do`, which RETRIES a step that throws.
        // `exec` throws on outcomes that occur after the command already ran —
        // the runner crashing while serialising the result, or output past the
        // cap — so rethrowing would re-execute an approved `pnpm publish`. The
        // step has to complete, with the failure as its value.
        await expect(invokeSandbox({ containers }, { command: "pnpm", instance: "t-1", kind: "container", name: "sandbox", op: "exec" })).resolves.toBe(
            "exec failed: ctx.containers.sandbox: exec failed — the container answered 500 for POST /__lunora/exec",
        );
        expect(exec).toHaveBeenCalledTimes(1);
    });

    it("refuses a container op that arrived with no instance rather than sharing one", async () => {
        const get = vi.fn<(name: string) => never>();
        const containers = {
            sandbox: {
                any: () => {
                    throw new Error("must not reach .any()");
                },
                get,
            },
        };

        // `idFromName("")` is a valid address, so defaulting would route every
        // thread to one shared container — the defect this replaced, silently.
        await expect(invokeSandbox({ containers }, { kind: "container", name: "sandbox", op: "fetch", path: "/" })).rejects.toThrow(NO_INSTANCE_ERROR);
        expect(get).not.toHaveBeenCalled();
    });

    it("errors when a container op names an unknown container", async () => {
        await expect(invokeSandbox({ containers: {} }, { instance: "t-1", kind: "container", name: "missing", op: "fetch", path: "/" })).rejects.toThrow(
            UNKNOWN_CONTAINER_ERROR,
        );
    });

    it("routes a fs op to the R2 bucket resolved from ctx.env[bucket]", async () => {
        const { bucket, store } = memoryBucket();

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
