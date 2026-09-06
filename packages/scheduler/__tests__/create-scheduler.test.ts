import { describe, expect, expectTypeOf, it, vi } from "vitest";

import createScheduler from "../src/create-scheduler";
import { createCronTrigger } from "../src/cron";
import type { DurableObjectNamespaceLike, DurableObjectStubLike, FunctionReference, ScheduleRecord, WorkflowReference } from "../src/types";

const NAMESPACE_PATTERN = /namespace/;
const DELAY_MS_PATTERN = /delayMs/;
const SCHEDULER_DO_PATTERN = /SchedulerDO/;
const MISSING_BINDING_PATTERN = /missing its `binding`/;

interface CapturedCall {
    body: Record<string, unknown>;
    url: string;
}

const DEFAULT_RESPONSES: Record<string, unknown> = { "/cancel": { cancelled: true }, "/schedule": { id: "id-1", scheduledFor: 12_345 } };

const fakeNamespace = (responses: Record<string, unknown> = DEFAULT_RESPONSES): { calls: CapturedCall[]; namespace: DurableObjectNamespaceLike } => {
    const calls: CapturedCall[] = [];
    const stub = {
        fetch: vi.fn<DurableObjectStubLike["fetch"]>(async (input: Request | string, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.url;
            const body = init?.body ? JSON.parse(init.body as string) : {};
            const path = new URL(url).pathname;

            calls.push({ body, url });

            // The DO's `/get?id=` route is derived from the same `/list` records
            // the fake is seeded with: look the id up and answer `{ record }` on a
            // hit, `{}` on a miss (mirroring the real DO's absent-field contract).
            if (path === "/get") {
                const id = new URL(url).searchParams.get("id");
                const seeded = (responses["/list"] as { records?: ScheduleRecord[] } | undefined)?.records ?? [];
                const record = seeded.find((candidate) => candidate.id === id);

                return Response.json(record ? { record } : {}, { headers: { "content-type": "application/json" }, status: 200 });
            }

            const responseBody = responses[path] ?? { ok: true };

            return Response.json(responseBody, { headers: { "content-type": "application/json" }, status: 200 });
        }),
    };
    const namespace: DurableObjectNamespaceLike = {
        get: vi.fn<DurableObjectNamespaceLike["get"]>(() => stub),
        idFromName: vi.fn<DurableObjectNamespaceLike["idFromName"]>((name: string) => {
            return { toString: () => name };
        }),
    };

    return { calls, namespace };
};

// A mutation, not a bare `FunctionReference`: `stream` is not schedulable, so
// the schedulable types are narrowed to exclude it and an unconstrained
// reference no longer satisfies them.
const fnRef: FunctionReference<"mutation"> = { __lunoraRef: "messages.send" };

// The generated `agents.<name>` / `workflows.<name>` schedule target: a
// WorkflowReference carrying the `AGENT_*`/`WORKFLOW_*` binding + stable name.
const agentRef: WorkflowReference = { binding: "AGENT_SUPPORT", isLunoraWorkflow: true, name: "support" };

describe("createScheduler", () => {
    it("requires a namespace", () => {
        expect.assertions(1);

        expect(() => createScheduler({} as never)).toThrow(NAMESPACE_PATTERN);
    });

    it("runAt() forwards the RPC envelope to SchedulerDO", async () => {
        expect.assertions(3);

        const { calls, namespace } = fakeNamespace();
        const scheduler = createScheduler({ namespace });
        const at = new Date("2026-06-01T12:00:00Z");

        const result = await scheduler.runAt(at, fnRef, { userId: "u-1" });

        expect(result).toBe("id-1");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.body).toEqual({
            args: { userId: "u-1" },
            functionPath: "messages.send",
            instanceName: "default",
            scheduledFor: at.getTime(),
            shardKey: undefined,
        });
    });

    // Regression (contract drift): `runAfter`/`runAt` used to resolve the DO's
    // `{ id, scheduledFor }` record, while every gate that describes this object
    // — `SchedulerLike` (@lunora/shard-engine), `Scheduler` (@lunora/server),
    // `ctx.scheduler` (@lunora/runtime) and the docs — says `Promise<string>`.
    // The generated shard installs it with a bare cast, so only an assertion here
    // catches the drift: in a mutation you got an object, wrote it into a string
    // column, and `cancel(id)` answered `{ cancelled: false }` with no error.
    it("resolves the bare job id, not the DO's record", async () => {
        expect.assertions(2);

        const { namespace } = fakeNamespace();
        const scheduler = createScheduler({ namespace });

        const id = await scheduler.runAfter(0, fnRef, { userId: "u-1" });

        expect(id).toBe("id-1");
        expect(typeof id).toBe("string");

        expectTypeOf<Awaited<ReturnType<typeof scheduler.runAfter>>>().toEqualTypeOf<string>();
        expectTypeOf<Awaited<ReturnType<typeof scheduler.runAt>>>().toEqualTypeOf<string>();
    });

    it("runAt() carries the scheduler's instanceName so a pooled slot is released on the right DO", async () => {
        expect.assertions(3);

        // Regression: the envelope omitted `instanceName`, so the DO released the
        // slot on `default` while it had been reserved on `tenant-a` — one leaked
        // slot per job (fatal at a cap of 1) plus a phantom pool row on the wrong
        // instance.
        const { calls, namespace } = fakeNamespace();
        const scheduler = createScheduler({ instanceName: "tenant-a", namespace });

        await scheduler.runAfter(0, fnRef, { userId: "u-1" }, { maxConcurrency: 4, pool: "billing" });

        expect(calls[0]?.body["instanceName"]).toBe("tenant-a");
        expect(calls[0]?.body["pool"]).toBe("billing");
        expect(calls[0]?.body["maxConcurrency"]).toBe(4);
    });

    it("runAt() omits maxConcurrency for an unpooled job", async () => {
        expect.assertions(1);

        const { calls, namespace } = fakeNamespace();
        const scheduler = createScheduler({ namespace });

        await scheduler.runAfter(0, fnRef, { userId: "u-1" }, { maxConcurrency: 4 });

        expect(calls[0]?.body).not.toHaveProperty("maxConcurrency");
    });

    it("runAt() sends a workflow binding (not functionPath) for an agent/workflow target", async () => {
        expect.assertions(3);

        const { calls, namespace } = fakeNamespace();
        const scheduler = createScheduler({ namespace });
        const at = new Date("2026-06-01T12:00:00Z");

        const result = await scheduler.runAt(at, agentRef, { prompt: "summarize" });

        expect(result).toBe("id-1");
        // The wire payload carries the binding under `workflow` and omits `functionPath`.
        expect(calls[0]?.body).toEqual({
            args: { prompt: "summarize" },
            instanceName: "default",
            scheduledFor: at.getTime(),
            workflow: "AGENT_SUPPORT",
        });
        expect(calls[0]?.body).not.toHaveProperty("functionPath");
    });

    it("runAfter() forwards a workflow target the same way", async () => {
        expect.assertions(2);

        const { calls, namespace } = fakeNamespace();
        const scheduler = createScheduler({ namespace });

        await scheduler.runAfter(5000, agentRef, { prompt: "digest" });

        expect(calls[0]?.body.workflow).toBe("AGENT_SUPPORT");
        expect(calls[0]?.body).not.toHaveProperty("functionPath");
    });

    it("runAt() rejects a workflow target with no binding", async () => {
        expect.assertions(2);

        const { calls, namespace } = fakeNamespace();
        const scheduler = createScheduler({ namespace });

        await expect(scheduler.runAt(1000, { isLunoraWorkflow: true }, {})).rejects.toThrow(MISSING_BINDING_PATTERN);
        // Nothing was dispatched to the DO.
        expect(calls).toHaveLength(0);
    });

    it("runAfter() rejects negative or non-finite delays", async () => {
        expect.assertions(2);

        const { namespace } = fakeNamespace();
        const scheduler = createScheduler({ namespace });

        await expect(scheduler.runAfter(-1, fnRef, {})).rejects.toThrow(DELAY_MS_PATTERN);
        await expect(scheduler.runAfter(Number.NaN, fnRef, {})).rejects.toThrow(DELAY_MS_PATTERN);
    });

    it("runAfter() computes scheduledFor relative to now()", async () => {
        expect.assertions(3);

        const { calls, namespace } = fakeNamespace();
        const scheduler = createScheduler({ namespace });

        const before = Date.now();

        await scheduler.runAfter(5000, fnRef, { x: 1 }, { shardKey: "u-1" });
        const after = Date.now();

        const scheduledFor = calls[0]?.body.scheduledFor as number;

        expect(scheduledFor).toBeGreaterThanOrEqual(before + 5000);
        expect(scheduledFor).toBeLessThanOrEqual(after + 5000);
        expect(calls[0]?.body.shardKey).toBe("u-1");
    });

    it("cancel() forwards the id", async () => {
        expect.assertions(3);

        const { calls, namespace } = fakeNamespace();
        const scheduler = createScheduler({ namespace });

        const result = await scheduler.cancel("abc");

        expect(result).toEqual({ cancelled: true });
        expect(calls[0]?.body).toEqual({ id: "abc" });
        expect(new URL(calls[0]!.url).pathname).toBe("/cancel");
    });

    it("list() parses the DO's record array (GET /list)", async () => {
        expect.assertions(3);

        const records = [
            { args: { x: 1 }, enqueuedAt: 1, functionPath: "messages.send", id: "a", scheduledFor: 10 },
            { args: {}, enqueuedAt: 2, functionPath: "messages.purge", id: "b", scheduledFor: 20 },
        ];
        const { calls, namespace } = fakeNamespace({ "/list": { records } });
        const scheduler = createScheduler({ namespace });

        const result = await scheduler.list();

        expect(result).toEqual(records);
        expect(new URL(calls[0]!.url).pathname).toBe("/list");
        expect(calls).toHaveLength(1);
    });

    it("get() resolves a single record via the direct GET /get?id= route", async () => {
        expect.assertions(4);

        const records = [{ args: {}, enqueuedAt: 1, functionPath: "messages.send", id: "a", scheduledFor: 10 }];
        const { calls, namespace } = fakeNamespace({ "/list": { records } });
        const scheduler = createScheduler({ namespace });

        await expect(scheduler.get("a")).resolves.toEqual(records[0]);
        await expect(scheduler.get("missing")).resolves.toBeNull();

        // O(1) lookup: a dedicated `/get` read, not a full `/list` scan.
        const url = new URL(calls[0]!.url);

        expect(url.pathname).toBe("/get");
        expect(url.searchParams.get("id")).toBe("a");
    });

    it("list()/get() stay robust when the DO 200s without a `records` array", async () => {
        expect.assertions(2);

        // DO drift / unexpected 200 body: `records` absent. list() must return
        // [] (not undefined) and get() must resolve null rather than throwing.
        const { namespace } = fakeNamespace({ "/list": { ok: true } });
        const scheduler = createScheduler({ namespace });

        await expect(scheduler.list()).resolves.toEqual([]);
        await expect(scheduler.get("a")).resolves.toBeNull();
    });

    it("throws when SchedulerDO returns a non-2xx response", async () => {
        expect.assertions(1);

        const stub = {
            fetch: vi.fn<DurableObjectStubLike["fetch"]>(async () => new Response("nope", { status: 500 })),
        };
        const namespace: DurableObjectNamespaceLike = {
            get: () => stub,
            idFromName: () => {
                return { toString: () => "default" };
            },
        };
        const scheduler = createScheduler({ namespace });

        await expect(scheduler.runAfter(0, fnRef, {})).rejects.toThrow(SCHEDULER_DO_PATTERN);
    });

    it("propagates the SchedulerDO's coded refusal instead of re-wrapping it as INTERNAL", async () => {
        expect.assertions(3);

        const stub = {
            fetch: vi.fn<DurableObjectStubLike["fetch"]>(async () =>
                Response.json({ error: { code: "DUPLICATE_SCHEDULE_ID", message: 'a job with id "invoice-42" is already scheduled' } }, { status: 409 }),
            ),
        };
        const namespace: DurableObjectNamespaceLike = {
            get: () => stub,
            idFromName: () => {
                return { toString: () => "default" };
            },
        };
        const scheduler = createScheduler({ namespace });

        // Flattened to `INTERNAL`, the message is what `toErrorBody` redacts — so
        // the developer who named a job id twice was shown "Internal error" and
        // nothing else.
        const thrown = await scheduler.runAfter(0, fnRef, {}).then(
            () => undefined,
            (error: unknown) => error,
        );

        expect(thrown).toMatchObject({ code: "DUPLICATE_SCHEDULE_ID", status: 409 });
        expect(thrown).toHaveProperty("message", 'a job with id "invoice-42" is already scheduled');
        expect(thrown).not.toMatchObject({ code: "INTERNAL" });
    });

    it("createCronTrigger emits a wrangler.jsonc snippet + dispatcher metadata", () => {
        expect.assertions(3);

        const snippet = createCronTrigger({ args: { tenant: "acme" }, fn: fnRef, schedule: "0 * * * *" });

        expect(snippet.crons).toEqual(["0 * * * *"]);
        expect(snippet.dispatcher).toEqual({ args: { tenant: "acme" }, functionPath: "messages.send" });
        expect(snippet.wranglerJsonc).toContain('"0 * * * *"');
    });

    it("createCronTrigger validates inputs", () => {
        expect.assertions(2);

        expect(() => createCronTrigger({ fn: fnRef, schedule: "" })).toThrow("requires `schedule` and `fn`");
        // @ts-expect-error - intentional misuse
        expect(() => createCronTrigger({ schedule: "0 * * * *" })).toThrow("requires `schedule` and `fn`");
    });

    it("createCronTrigger accepts named weekday/month tokens", () => {
        expect.assertions(4);

        // Standard + Cloudflare-accepted named day-of-week / month fields.
        expect(() => createCronTrigger({ fn: fnRef, schedule: "0 0 * * MON" })).not.toThrow();
        expect(() => createCronTrigger({ fn: fnRef, schedule: "0 0 1 JAN *" })).not.toThrow();
        expect(() => createCronTrigger({ fn: fnRef, schedule: "0 9 * * MON-FRI" })).not.toThrow();
        expect(() => createCronTrigger({ fn: fnRef, schedule: "0 0 1 jan-mar *" })).not.toThrow();
    });

    it("createCronTrigger still rejects free-form prose", () => {
        expect.assertions(2);

        expect(() => createCronTrigger({ fn: fnRef, schedule: "every minute" })).toThrow("invalid cron expression");
        expect(() => createCronTrigger({ fn: fnRef, schedule: "0 0 * *" })).toThrow("invalid cron expression");
    });
});

describe("createScheduler jurisdiction", () => {
    it("routes through a jurisdiction-pinned subnamespace when configured", async () => {
        expect.assertions(2);

        const { namespace: inner } = fakeNamespace();
        const jurisdictionCalls: string[] = [];
        const namespace: DurableObjectNamespaceLike = {
            get: () => {
                throw new Error("should resolve via the jurisdiction subnamespace, not the root namespace");
            },
            idFromName: () => {
                throw new Error("should resolve via the jurisdiction subnamespace, not the root namespace");
            },
            jurisdiction: (j) => {
                jurisdictionCalls.push(j);

                return inner;
            },
        };

        const scheduler = createScheduler({ jurisdiction: "us", namespace });

        await scheduler.runAfter(1000, fnRef, {});

        expect(jurisdictionCalls).toStrictEqual(["us"]);
        // The pinned subnamespace resolves the default instance — proving routing
        // went through it (its `get`/`idFromName`, not the root namespace's, which throw).
        expect(inner.idFromName as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("default");
    });

    it("fails closed when the binding lacks jurisdiction support", async () => {
        expect.assertions(1);

        const { namespace } = fakeNamespace();
        const scheduler = createScheduler({ jurisdiction: "eu", namespace });

        await expect(scheduler.runAfter(1000, fnRef, {})).rejects.toThrow(/does not support jurisdiction/);
    });
});
