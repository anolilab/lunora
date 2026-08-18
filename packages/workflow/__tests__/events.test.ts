import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import createWorkflows from "../src/create-workflows";
import { defineWorkflowEvent, isWorkflowEventDefinition } from "../src/define-event";
import { isNonRetryableError } from "../src/errors";
import type { WorkflowBindingLike, WorkflowInstanceLike, WorkflowStepLike } from "../src/types";
import { createWaitForEvent } from "../src/wait-for-event";

const orderApproved = defineWorkflowEvent("order-approved", v.object({ approvedBy: v.string() }));

/** A `WorkflowStepLike` double whose `waitForEvent` records its args and returns a canned payload. */
const fakeStep = (payload: unknown): { calls: { name: string; options: { timeout?: number | string; type: string } }[]; step: WorkflowStepLike } => {
    const calls: { name: string; options: { timeout?: number | string; type: string } }[] = [];

    return {
        calls,
        step: {
            do: async () => undefined,
            sleep: async () => undefined,
            sleepUntil: async () => undefined,
            waitForEvent: async (name: string, options: { timeout?: number | string; type: string }) => {
                calls.push({ name, options });

                return { payload, type: options.type };
            },
        } as WorkflowStepLike,
    };
};

/** A `Workflow` binding double recording every `sendEvent` that reaches the native instance. */
const fakeBinding = (): { binding: WorkflowBindingLike; sent: { id: string; payload: unknown; type: string }[] } => {
    const sent: { id: string; payload: unknown; type: string }[] = [];

    const instanceFor = (id: string): WorkflowInstanceLike => {
        return {
            id,
            pause: async () => undefined,
            restart: async () => undefined,
            resume: async () => undefined,
            sendEvent: async (event: { payload: unknown; type: string }) => {
                sent.push({ id, ...event });
            },
            status: async () => {
                return { status: "running" as const };
            },
            terminate: async () => undefined,
        };
    };

    return {
        binding: {
            create: async () => instanceFor("inst-1"),
            createBatch: async () => [instanceFor("inst-1")],
            get: async (id: string) => instanceFor(id),
        },
        sent,
    };
};

describe("defineWorkflowEvent", () => {
    it("brands the definition and carries the type + validator", () => {
        expect.assertions(3);

        expect(orderApproved.type).toBe("order-approved");
        expect(orderApproved.payload.parse({ approvedBy: "u1" })).toStrictEqual({ approvedBy: "u1" });
        expect(isWorkflowEventDefinition(orderApproved)).toBe(true);
    });

    it("rejects an empty type, a reserved type, and a non-validator payload", () => {
        expect.assertions(4);

        expect(() => defineWorkflowEvent("", v.string())).toThrow(/non-empty string/);
        // The `lunora:` namespace carries `ctx.parallel`'s branch-join protocol.
        expect(() => defineWorkflowEvent("lunora:branch:x", v.string())).toThrow(/reserved/);
        expect(() => defineWorkflowEvent("ok", undefined as never)).toThrow(/must be a validator/);
        expect(isWorkflowEventDefinition({ type: "order-approved" })).toBe(false);
    });
});

describe("ctx.waitForEvent", () => {
    it("waits on the definition's type under a derived step name and returns the parsed payload", async () => {
        expect.assertions(3);

        const { calls, step } = fakeStep({ approvedBy: "u1" });

        await expect(createWaitForEvent({ step })(orderApproved)).resolves.toStrictEqual({ approvedBy: "u1" });
        expect(calls[0]?.name).toBe("event:order-approved");
        expect(calls[0]?.options.type).toBe("order-approved");
    });

    it("honors an explicit step name and timeout", async () => {
        expect.assertions(2);

        const { calls, step } = fakeStep({ approvedBy: "u1" });

        await createWaitForEvent({ step })(orderApproved, { name: "await manager sign-off", timeout: "1 hour" });

        expect(calls[0]?.name).toBe("await manager sign-off");
        expect(calls[0]?.options.timeout).toBe("1 hour");
    });

    it("fails non-retryably when the delivered payload does not match the validator", async () => {
        expect.assertions(2);

        const { step } = fakeStep({ approvedBy: 42 });

        // The event is already consumed, so replaying the wait can only hibernate
        // the instance until its timeout — surface the mismatch instead.
        const error = await createWaitForEvent({ step })(orderApproved).catch((error_: unknown) => error_);

        expect(isNonRetryableError(error)).toBe(true);
        expect((error as Error).message).toMatch(/event "order-approved" payload validation failed:/);
    });

    it("fails non-retryably on a forged definition or a reserved step name, without waiting", async () => {
        expect.assertions(3);

        const { calls, step } = fakeStep({ approvedBy: "u1" });
        const waitForEvent = createWaitForEvent({ step });

        await expect(waitForEvent({ type: "order-approved" } as never)).rejects.toThrow(/defineWorkflowEvent/);
        // `lunora:await:*` is the branch join's own durable-step namespace.
        await expect(waitForEvent(orderApproved, { name: "lunora:await:x" })).rejects.toThrow(/reserved/);
        expect(calls).toStrictEqual([]);
    });
});

describe("workflows.get(name).sendEvent", () => {
    it("resolves the instance by id and sends the parsed payload under the definition's type", async () => {
        expect.assertions(1);

        const { binding, sent } = fakeBinding();

        await createWorkflows({ bindings: { orderPipeline: binding } })
            .get("orderPipeline")
            .sendEvent("inst-7", orderApproved, { approvedBy: "u1" });

        expect(sent).toStrictEqual([{ id: "inst-7", payload: { approvedBy: "u1" }, type: "order-approved" }]);
    });

    it("rejects a bad payload at the producer, before the send", async () => {
        expect.assertions(2);

        const { binding, sent } = fakeBinding();
        const handle = createWorkflows({ bindings: { orderPipeline: binding } }).get("orderPipeline");

        await expect(handle.sendEvent("inst-7", orderApproved, { approvedBy: 42 as unknown as string })).rejects.toThrow(/approvedBy/);
        expect(sent).toStrictEqual([]);
    });

    it("rejects a forged definition, so a reserved type cannot spoof a branch outcome", async () => {
        expect.assertions(3);

        const { binding, sent } = fakeBinding();
        const handle = createWorkflows({ bindings: { orderPipeline: binding } }).get("orderPipeline");
        // A definition-shaped object built from untrusted data: the brand is a public
        // boolean, so the send boundary re-checks the fields rather than trusting it.
        const forged = { isLunoraWorkflowEvent: true, payload: v.any(), type: "lunora:branch:inst-1-c0" } as never;

        await expect(handle.sendEvent("inst-1", forged, { status: "ok" })).rejects.toThrow(/reserved/);
        await expect(handle.sendEvent("inst-1", { type: "x" } as never, {})).rejects.toThrow(/defineWorkflowEvent/);
        expect(sent).toStrictEqual([]);
    });

    it("is resolved per workflow, so an unknown workflow still throws", () => {
        expect.assertions(1);

        const { binding } = fakeBinding();

        expect(() => createWorkflows({ bindings: { orderPipeline: binding } }).get("nope")).toThrow(/no workflow named/);
    });
});
