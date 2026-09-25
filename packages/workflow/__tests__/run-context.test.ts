import { v } from "@lunora/values";
import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeWire } from "../../../shared/wire-codec";
import { defineWorkflowEvent } from "../src/define-event";
import { defineStep } from "../src/define-step";
import { createWorkflowRunContext } from "../src/run-context";
import type { WorkflowEventLike, WorkflowStepContextLike, WorkflowStepLike } from "../src/types";

const okResponse = (body: string): Response => new Response(body, { status: 200 });

const makeStep = (): WorkflowStepLike =>
    ({
        do: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
        sleep: vi.fn<(name: string, duration: number | string) => Promise<void>>(),
        sleepUntil: vi.fn<(name: string, timestamp: Date | number) => Promise<void>>(),
        waitForEvent: vi.fn<(name: string, options: { timeout?: number | string; type: string }) => Promise<{ payload: Readonly<unknown>; type: string }>>(),
    }) as unknown as WorkflowStepLike;

const makeEvent = (): WorkflowEventLike<{ orderId: string }> => {
    return {
        instanceId: "inst-1",
        payload: { orderId: "o1" },
        timestamp: new Date(0),
        workflowName: "order-pipeline",
    };
};

// The dispatch runner + logger implementations are owned and tested by
// `@lunora/dispatch`; here we only verify workflow's context assembly and that
// `ctx.run` / `ctx.log` are wired through to the shared primitives.
describe("createWorkflowRunContext", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("decodes wire-form params, so a scheduled workflow sees real bigint and Date values", () => {
        expect.assertions(2);

        // A scheduled workflow's args arrive in wire form on purpose: Workflow
        // `params` are JSON-serialised into durable storage, so a decoded bigint
        // would fail creation and a decoded Date would flatten to a string. This is
        // the first point that can hand the handler the real values.
        const event = { ...makeEvent(), payload: encodeWire({ at: new Date(0), total: 9_007_199_254_740_993n }) as Record<string, unknown> };
        const ctx = createWorkflowRunContext({ env: { LUNORA_ORIGIN_URL: "x" }, event, exportName: "orderPipeline", step: makeStep() });

        expect(ctx.params).toStrictEqual({ at: new Date(0), total: 9_007_199_254_740_993n });

        // Pure-JSON params are untouched, so a directly created instance is unaffected.
        const plain = createWorkflowRunContext({
            env: { LUNORA_ORIGIN_URL: "x" },
            event: { ...makeEvent(), payload: { orderId: "o1" } },
            exportName: "orderPipeline",
            step: makeStep(),
        });

        expect(plain.params).toStrictEqual({ orderId: "o1" });
    });

    it("assembles the handler context with params, event, step, env, run, and log", () => {
        expect.assertions(6);

        const event = makeEvent();
        const step = makeStep();
        const ctx = createWorkflowRunContext({ env: { LUNORA_ORIGIN_URL: "x" }, event, exportName: "orderPipeline", step });

        expect(ctx.params).toEqual({ orderId: "o1" });
        expect(ctx.event).toBe(event);
        expect(ctx.step).toBe(step);
        expect(ctx.env).toEqual({ LUNORA_ORIGIN_URL: "x" });
        expect(typeof ctx.run).toBe("function");
        expect(typeof ctx.log.info).toBe("function");
    });

    it("wires the fan-out primitives (ctx.parallel / ctx.spawn)", () => {
        expect.assertions(2);

        const ctx = createWorkflowRunContext({ env: {}, event: makeEvent(), exportName: "orderPipeline", step: makeStep() });

        expect(typeof ctx.parallel).toBe("function");
        expect(typeof ctx.spawn).toBe("function");
    });

    it("wires ctx.waitForEvent onto the native step API", async () => {
        expect.assertions(2);

        const step = makeStep();
        const waitForEvent = step.waitForEvent as unknown as ReturnType<typeof vi.fn>;

        waitForEvent.mockResolvedValue({ payload: { approvedBy: "u1" }, type: "order-approved" });

        const ctx = createWorkflowRunContext({ env: {}, event: makeEvent(), exportName: "orderPipeline", step });
        const orderApproved = defineWorkflowEvent("order-approved", v.object({ approvedBy: v.string() }));

        await expect(ctx.waitForEvent(orderApproved)).resolves.toStrictEqual({ approvedBy: "u1" });
        expect(waitForEvent).toHaveBeenCalledWith("event:order-approved", expect.objectContaining({ type: "order-approved" }));
    });

    it("runs one step repeatedly in a loop, as Cloudflare's (name, type, occurrence) step identity allows", async () => {
        expect.assertions(2);

        // A loop over items reusing one step name is a documented Workflows
        // pattern: `step.count` counts the occurrences of a name within a run,
        // and each occurrence caches independently. The context must not get in
        // the way of it.
        const names: string[] = [];
        const step = {
            do: async (name: string, callback: unknown) => {
                names.push(name);

                return (callback as (context: WorkflowStepContextLike) => Promise<unknown>)({
                    attempt: 1,
                    config: {},
                    step: { count: names.filter((seen) => seen === name).length, name },
                });
            },
            sleep: async () => undefined,
            sleepUntil: async () => undefined,
            waitForEvent: async () => {
                return { payload: {}, type: "x" };
            },
        } as unknown as WorkflowStepLike;

        const ctx = createWorkflowRunContext({ env: {}, event: makeEvent(), exportName: "orderPipeline", step });
        const processItem = defineStep("processItem", {
            args: { item: v.string() },
            handler: async (_stepContext, { item }) => `done:${item}`,
        });

        const results: string[] = [];

        for (const item of ["a", "b", "c"]) {
            // eslint-disable-next-line no-await-in-loop -- sequential by design: this is the loop-over-items pattern under test
            results.push(await ctx.runStep(processItem, { item }));
        }

        expect(results).toStrictEqual(["done:a", "done:b", "done:c"]);
        expect(names).toStrictEqual(["processItem", "processItem", "processItem"]);
    });

    it("spawning a workflow with no matching WORKFLOW_* binding throws a helpful error", async () => {
        expect.assertions(1);

        const ctx = createWorkflowRunContext({ env: {}, event: makeEvent(), exportName: "orderPipeline", step: makeStep() });

        await expect(ctx.spawn("imageTag")).rejects.toThrow('cannot spawn child workflow "imageTag"');
    });

    it("wires ctx.run through the shared dispatch runner (POST + workflow label on error)", async () => {
        expect.assertions(3);

        // The shard's envelope (`ShardDO.buildDispatchResponse`), not the bare
        // return value — `ctx.run` unwraps `result` and `decodeWire`s it.
        const fetchImpl = vi.fn<typeof fetch>(async () => okResponse(JSON.stringify({ result: { ok: true } })));
        const ctx = createWorkflowRunContext({
            env: { LUNORA_ADMIN_TOKEN: "secret", LUNORA_ORIGIN_URL: "https://app.example.com" },
            event: makeEvent(),
            exportName: "orderPipeline",
            fetchImpl,
            step: makeStep(),
        });

        await expect(ctx.run({ __lunoraRef: "payments:charge" }, { orderId: "o1" })).resolves.toEqual({ ok: true });
        expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://app.example.com/_lunora/scheduler/dispatch");

        const failing = createWorkflowRunContext({
            env: { LUNORA_ADMIN_TOKEN: "secret", LUNORA_ORIGIN_URL: "https://app.example.com" },
            event: makeEvent(),
            exportName: "orderPipeline",
            fetchImpl: async () => new Response("boom", { status: 500 }),
            step: makeStep(),
        });

        await expect(failing.run({ __lunoraRef: "a:b" })).rejects.toThrow(/@lunora\/workflow: function dispatch failed \(500\): boom/);
    });

    it("pins a replay-stable dedup id on ctx.run, so a replayed body applies each call once", async () => {
        expect.assertions(2);

        // A top-level `ctx.run` is NOT durable: the body re-executes from the top
        // on every activation (after a `step.sleep`, a `waitForEvent`, an
        // eviction), so without a replay-stable id the second activation charges
        // the customer again. Two contexts over the same event ARE the replay.
        const ids: unknown[] = [];
        const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
            ids.push((JSON.parse((init as RequestInit).body as string) as { id?: string }).id);

            return okResponse(JSON.stringify({ result: null }));
        });
        const env = { LUNORA_ADMIN_TOKEN: "secret", LUNORA_ORIGIN_URL: "https://app.example.com" };

        const activation = async (): Promise<void> => {
            const ctx = createWorkflowRunContext({ env, event: makeEvent(), exportName: "orderPipeline", fetchImpl, step: makeStep() });

            await ctx.run({ __lunoraRef: "payments:charge" }, { orderId: "o1" });
            await ctx.run({ __lunoraRef: "orders:markPaid" }, { orderId: "o1" });
        };

        await activation();
        await activation();

        expect(ids).toStrictEqual(["orderPipeline/inst-1#body.1", "orderPipeline/inst-1#body.2", "orderPipeline/inst-1#body.1", "orderPipeline/inst-1#body.2"]);

        // A caller-supplied id wins — the escape hatch for a body whose call order
        // is not deterministic, and the only way to make a bare `ctx.run` inside a
        // raw `ctx.step.do(...)` callback exactly-once across that step's retries.
        const ctx = createWorkflowRunContext({ env, event: makeEvent(), exportName: "orderPipeline", fetchImpl, step: makeStep() });

        await ctx.run({ __lunoraRef: "payments:charge" }, {}, { dedupId: "charge:o1" });

        expect(ids.at(-1)).toBe("charge:o1");
    });

    it("keeps two workflows whose instances share an id apart: each dispatched handler runs exactly once", async () => {
        expect.assertions(2);

        // Instance ids are unique only WITHIN one workflow, and callers pass
        // business keys, so `chargeOrder` and `notifyCustomer` both running as
        // `order-42` is ordinary. The shard dedups on `(identity, mutationId)`
        // with no function path, and every system dispatch shares one identity —
        // modelled here: a repeated id is answered from the cache, its handler
        // never entered.
        const runs = new Map<string, number>();
        const cache = new Map<string, string>();
        const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
            const { functionPath, id } = JSON.parse((init as RequestInit).body as string) as { functionPath: string; id?: string };
            const cached = id === undefined ? undefined : cache.get(id);

            if (cached !== undefined) {
                return okResponse(cached);
            }

            runs.set(functionPath, (runs.get(functionPath) ?? 0) + 1);

            const body = JSON.stringify({ result: functionPath });

            if (id !== undefined) {
                cache.set(id, body);
            }

            return okResponse(body);
        });
        const step = {
            ...makeStep(),
            do: async (name: string, callback: (context: WorkflowStepContextLike) => Promise<unknown>) =>
                callback({ attempt: 1, config: {}, step: { count: 1, name } }),
        } as unknown as WorkflowStepLike;
        const env = { LUNORA_ADMIN_TOKEN: "secret", LUNORA_ORIGIN_URL: "https://app.example.com" };
        const event = { ...makeEvent(), instanceId: "order-42" };
        const dispatchStep = (functionPath: string) =>
            defineStep(functionPath, {
                args: {},
                handler: async (context) => context.run({ __lunoraRef: functionPath }),
            });

        const runWorkflow = async (exportName: string, prefix: string): Promise<void> => {
            const ctx = createWorkflowRunContext({ env, event, exportName, fetchImpl, step });

            await ctx.run({ __lunoraRef: `${prefix}:body` });
            await ctx.runStep(dispatchStep(`${prefix}:step`), {});
        };

        await runWorkflow("chargeOrder", "billing");
        await runWorkflow("notifyCustomer", "email");

        // COUNTS, per handler: an unscoped id serves `email:*` from `billing:*`'s cache and reads 0 there.
        expect(Object.fromEntries(runs)).toStrictEqual({ "billing:body": 1, "billing:step": 1, "email:body": 1, "email:step": 1 });
        expect(fetchImpl).toHaveBeenCalledTimes(4);
    });

    it("gives the children of two workflows whose instances share an id distinct instance ids", async () => {
        expect.assertions(1);

        // A child's derived id is `create`d on the CHILD's binding, where a
        // duplicate is taken over as "a previous attempt already started it". Two
        // parents minting the same id there would attach to each other's child.
        const created: string[] = [];
        const binding = {
            create: async (options?: { id?: string }) => {
                if (created.includes(options?.id ?? "")) {
                    throw new Error("instance already exists");
                }

                created.push(options?.id ?? "");

                return { id: options?.id ?? "" };
            },
            get: async (id: string) => {
                return { id };
            },
        };
        const step = {
            ...makeStep(),
            do: async (_name: string, callback: () => Promise<unknown>) => callback(),
        } as unknown as WorkflowStepLike;
        const event = { ...makeEvent(), instanceId: "order-42" };

        const spawnFrom = async (exportName: string): Promise<void> => {
            await createWorkflowRunContext({ env: { WORKFLOW_SEND_RECEIPT: binding }, event, exportName, step }).spawn("sendReceipt", {});
        };

        await spawnFrom("chargeOrder");
        await spawnFrom("notifyCustomer");

        expect(new Set(created).size).toBe(2);
    });

    it("re-exposes the injected fetch so a body building its own dispatcher uses the same transport", () => {
        expect.assertions(2);

        // `ctx.run` is not the only dispatcher a body builds — `@lunora/agent`'s
        // loop builds its own to carry the run's identity. Consuming the
        // injection without re-exposing it sends that runner to a global `fetch`
        // the host replaced, or to none at all.
        const fetchImpl = vi.fn<typeof fetch>(async () => okResponse(JSON.stringify({ result: null })));

        expect(createWorkflowRunContext({ env: {}, event: makeEvent(), exportName: "orderPipeline", fetchImpl, step: makeStep() }).fetchImpl).toBe(fetchImpl);
        // Absent stays absent: a present key holding `undefined` reads as "the
        // host injected nothing" to a spread, and as an injection to `in`.
        expect(createWorkflowRunContext({ env: {}, event: makeEvent(), exportName: "orderPipeline", step: makeStep() })).not.toHaveProperty("fetchImpl");
    });

    it("prefixes ctx.log with the workflow name", () => {
        expect.assertions(1);

        const spy = vi.spyOn(console, "info").mockImplementation(() => {});
        const ctx = createWorkflowRunContext({ env: {}, event: makeEvent(), exportName: "orderPipeline", step: makeStep() });

        ctx.log.info("hi", 1);

        expect(spy).toHaveBeenCalledWith("[workflow:orderPipeline]", "hi", 1);
    });
});

describe("createWorkflowRunContext — undecodable params", () => {
    it("fails the instance without retrying instead of raising a bare codec error", () => {
        expect.assertions(3);

        // The params are already durable, so every retry decodes the identical
        // bytes to the identical failure. A bare `TypeError`/`RangeError` here
        // is retryable to the platform, so it burned the whole retry budget
        // re-deriving that same answer.
        const event = { ...makeEvent(), payload: ["$lunora.wire$", "bigint", "not-a-number"] as unknown as { orderId: string } };

        let thrown: unknown;

        try {
            createWorkflowRunContext({ env: {}, event, exportName: "orderPipeline", step: makeStep() });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).name).toBe("NonRetryableError");
        expect((thrown as Error).message).toMatch(/orderPipeline/u);
    });
});
