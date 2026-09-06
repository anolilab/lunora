import { describe, expect, it, vi } from "vitest";

import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import createScheduler from "../src/create-scheduler";
import createWorkpool from "../src/create-workpool";
import type { DurableObjectNamespaceLike, DurableObjectStubLike, FunctionReference, WorkflowReference } from "../src/types";

/**
 * The scheduler's `args` are a WIRE payload, and this pins both halves of that.
 *
 * `ctx.scheduler.runAfter/runAt` forwards `args` to the SchedulerDO as JSON, the
 * DO stores them, and on fire re-serialises them to the runtime — which hands a
 * function target's args to the shard, whose dispatch loop `decodeWire`s them
 * (`packages/do/src/shard-do.ts`). Un-encoded, that path was asymmetric in the
 * two ways the codec exists to prevent: a `bigint` arg threw at the producer's
 * own `JSON.stringify` before the job was ever recorded, and a `Date` silently
 * degraded to an ISO string by the time the handler read it.
 */

const at = new Date("2026-06-01T12:00:00.000Z");

/**
 * The `args` a producer actually put on the wire, after the JSON hop they must
 * survive. Deliberately `JSON.stringify` + `JSON.parse` rather than
 * `structuredClone`: the point is that the payload is JSON-safe, and
 * `structuredClone` would carry a `Date`/`bigint` through and prove nothing.
 */
const overTheWire = (body: Record<string, unknown>): unknown => {
    const json = JSON.stringify(body.args);

    return JSON.parse(json);
};

const fakeNamespace = (): { bodies: Record<string, unknown>[]; namespace: DurableObjectNamespaceLike } => {
    const bodies: Record<string, unknown>[] = [];
    const stub = {
        fetch: vi.fn<DurableObjectStubLike["fetch"]>(async (_input: Request | string, init?: RequestInit) => {
            bodies.push(init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {});

            return Response.json({ id: "job-1", scheduledFor: 1 }, { status: 200 });
        }),
    };

    return {
        bodies,
        namespace: {
            get: () => stub,
            idFromName: (name: string) => {
                return { toString: () => name };
            },
        },
    };
};

const fnRef: FunctionReference<"mutation"> = { __lunoraRef: "billing:settle" };
const workflowRef: WorkflowReference = { binding: "WORKFLOW_PAYOUT", isLunoraWorkflow: true, name: "payout" };

describe("scheduler args wire codec", () => {
    it("carries a bigint arg to a function target instead of throwing at the producer", async () => {
        expect.assertions(2);

        const { bodies, namespace } = fakeNamespace();
        const scheduler = createScheduler({ namespace, originUrl: "https://app.test" });

        // Un-encoded this rejects inside `JSON.stringify` ("Do not know how to
        // serialize a BigInt") — the job never reaches the DO at all.
        await scheduler.runAfter(1000, fnRef, { amountCents: 9_007_199_254_740_993n });

        expect(bodies).toHaveLength(1);
        // `decodeWire` is what the shard applies to `payload.args`, so this is
        // literally the value the handler is called with.
        expect(decodeWire(overTheWire(bodies[0] as Record<string, unknown>))).toStrictEqual({ amountCents: 9_007_199_254_740_993n });
    });

    it("carries a Date arg to a function target as a Date, not an ISO string", async () => {
        expect.assertions(2);

        const { bodies, namespace } = fakeNamespace();
        const scheduler = createScheduler({ namespace, originUrl: "https://app.test" });

        await scheduler.runAt(at, fnRef, { dueAt: at });

        const decoded = decodeWire(overTheWire(bodies[0] as Record<string, unknown>)) as { dueAt: unknown };

        // Fails SILENTLY without the codec: raw `JSON.stringify` renders a Date
        // as an ISO string, so the handler is handed a string and never throws.
        expect(decoded.dueAt).toBeInstanceOf(Date);
        expect(decoded.dueAt).toStrictEqual(at);
    });

    it("carries bigint and Date args to a workflow target", async () => {
        expect.assertions(3);

        const { bodies, namespace } = fakeNamespace();
        const scheduler = createScheduler({ namespace, originUrl: "https://app.test" });

        await scheduler.runAfter(1000, workflowRef, { dueAt: at, invoiceId: 42n });

        // The workflow branch sends `workflow` instead of `functionPath`; its args
        // are decoded by `@lunora/workflow`'s run-context, not by the shard.
        expect(bodies[0]).toMatchObject({ workflow: "WORKFLOW_PAYOUT" });

        const decoded = decodeWire(overTheWire(bodies[0] as Record<string, unknown>)) as { dueAt: unknown; invoiceId: unknown };

        expect(decoded.invoiceId).toBe(42n);
        expect(decoded.dueAt).toStrictEqual(at);
    });

    it("carries a bigint arg through a workpool enqueue", async () => {
        expect.assertions(1);

        const { bodies, namespace } = fakeNamespace();
        const pool = createWorkpool({ maxConcurrency: 2, namespace, originUrl: "https://app.test" });

        await pool.enqueue(fnRef, { amountCents: 1n });

        expect(decodeWire(overTheWire(bodies[0] as Record<string, unknown>))).toStrictEqual({ amountCents: 1n });
    });

    it("leaves plain-JSON args byte-identical, so nothing changes for existing callers", async () => {
        expect.assertions(2);

        const { bodies, namespace } = fakeNamespace();
        const scheduler = createScheduler({ namespace, originUrl: "https://app.test" });
        const plain = { attempt: 3, nested: { ok: true, tags: ["a", "b"] }, userId: "u-1" };

        await scheduler.runAfter(1000, fnRef, plain);

        // The codec is identity on a value with no special leaves — same bytes on
        // the wire as before, and the shard's decode gives the same object back.
        expect(bodies[0]?.args).toStrictEqual(plain);
        expect(decodeWire(overTheWire(bodies[0] as Record<string, unknown>))).toStrictEqual(plain);
    });
});

/**
 * A namespace whose DO answers the READ routes with records exactly as they sit
 * in its storage: `args` in wire form, everything else plain. That is what the
 * SchedulerDO actually holds — it stores the producer's envelope and never
 * inspects `args` — so these drive the other end of the hop the tests above
 * pin, rather than restating the producer's own invariant.
 */
const readOnlyNamespace = (record: Record<string, unknown>): DurableObjectNamespaceLike => {
    const stub = {
        fetch: vi.fn<DurableObjectStubLike["fetch"]>(async (input: Request | string) => {
            const path = new URL(typeof input === "string" ? input : input.url).pathname;

            if (path === "/get") {
                return Response.json({ record }, { status: 200 });
            }

            return Response.json({ records: [record] }, { status: 200 });
        }),
    };

    return {
        get: () => stub,
        idFromName: (name: string) => {
            return { toString: () => name };
        },
    };
};

/** The wire form of a job's args as it sits in the DO's storage, after the JSON hop it made to get there. */
const asStored = (args: Record<string, unknown>): Record<string, unknown> => {
    const json = JSON.stringify(encodeWire(args));

    return JSON.parse(json) as Record<string, unknown>;
};

const storedRecord = {
    args: asStored({ amountCents: 42n, dueAt: at }),
    enqueuedAt: 1,
    functionPath: "billing:settle",
    id: "job-1",
    scheduledFor: 2,
};

describe("scheduler read-back", () => {
    it.each(["list", "dead"] as const)("%s() hands back decoded args, not the tagged wire form", async (method) => {
        expect.assertions(4);

        const scheduler = createScheduler({ namespace: readOnlyNamespace(storedRecord), originUrl: "https://app.test" });
        const [record] = await scheduler[method]();

        expect(record?.args["dueAt"]).toBeInstanceOf(Date);
        expect(record?.args["dueAt"]).toStrictEqual(at);
        expect(record?.args["amountCents"]).toBe(42n);
        // The codec is the identity on the rest of the record, so the plain
        // fields are unchanged byte for byte.
        expect(record?.functionPath).toBe("billing:settle");
    });

    it("get() hands back decoded args, not the tagged wire form", async () => {
        expect.assertions(4);

        const scheduler = createScheduler({ namespace: readOnlyNamespace(storedRecord), originUrl: "https://app.test" });
        const record = await scheduler.get("job-1");

        expect(record?.args["dueAt"]).toBeInstanceOf(Date);
        expect(record?.args["amountCents"]).toBe(42n);
        expect(record?.id).toBe("job-1");
        expect(record?.scheduledFor).toBe(2);
    });

    it("leaves a plain-JSON record untouched on the way back", async () => {
        expect.assertions(1);

        const plain = { args: { attempt: 3, userId: "u-1" }, enqueuedAt: 1, functionPath: "billing:settle", id: "job-2", scheduledFor: 2 };
        const scheduler = createScheduler({ namespace: readOnlyNamespace(plain), originUrl: "https://app.test" });

        await expect(scheduler.get("job-2")).resolves.toStrictEqual(plain);
    });
});
