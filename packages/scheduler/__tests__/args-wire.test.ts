import { describe, expect, it, vi } from "vitest";

import { decodeWire } from "../../../shared/wire-codec";
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
