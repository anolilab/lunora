/**
 * `ctx.run` inside a workflow body is `@lunora/dispatch`'s runner, POSTing to
 * `/_lunora/scheduler/dispatch`. The shard's dispatch loop decodes the body's
 * `args` exactly once (`decodeWire(payload.args ?? {})`), so this end has to
 * encode: without it a `bigint` throws in `JSON.stringify` before the request
 * leaves, and a `Date` reaches the handler as an ISO string.
 */
import { describe, expect, it } from "vitest";

import { decodeWire } from "../../../shared/wire-codec";
import { createWorkflowRunContext } from "../src/run-context";
import type { FunctionReference, WorkflowEventLike, WorkflowStepLike } from "../src/types";

const ENV = { LUNORA_ADMIN_TOKEN: "admin-token", LUNORA_ORIGIN_URL: "https://app.example" };
const REF: FunctionReference = { __lunoraRef: "jobs:charge" };

const EVENT: WorkflowEventLike = {
    instanceId: "inst-1",
    payload: {},
    timestamp: new Date(0),
    workflowName: "orderPipeline",
};

/** Dispatch `args` through a real workflow `ctx.run` and hand back what the shard's single decode gives the handler. */
const handlerArgs = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    let body = "";

    const ctx = createWorkflowRunContext({
        env: ENV,
        event: EVENT,
        exportName: "orderPipeline",
        fetchImpl: async (_url: unknown, init?: RequestInit) => {
            body = init?.body as string;

            return new Response(null, { status: 200 });
        },
        step: {} as unknown as WorkflowStepLike,
    });

    await ctx.run(REF, args);

    return decodeWire((JSON.parse(body) as { args?: unknown }).args ?? {}) as Record<string, unknown>;
};

describe("workflow ctx.run args wire", () => {
    it("delivers a bigint argument to the handler as a bigint", async () => {
        expect.assertions(2);

        const args = await handlerArgs({ amountCents: 4_294_967_296n });

        expect(typeof args["amountCents"]).toBe("bigint");
        expect(args["amountCents"]).toBe(4_294_967_296n);
    });

    it("delivers a Date argument to the handler as a Date", async () => {
        expect.assertions(2);

        // Assert the TYPE: an un-encoded `Date` arrives as an ISO string and
        // nothing throws, so only the type catches it.
        const args = await handlerArgs({ dueAt: new Date("2026-06-01T12:00:00.000Z") });

        expect(args["dueAt"]).toBeInstanceOf(Date);
        expect((args["dueAt"] as Date).toISOString()).toBe("2026-06-01T12:00:00.000Z");
    });

    it("leaves pure-JSON args untouched at the handler", async () => {
        expect.assertions(1);

        const plain = { count: 3, flag: true, nested: { items: [1, 2, "three"], missing: null } };

        await expect(handlerArgs(plain)).resolves.toStrictEqual(plain);
    });
});
