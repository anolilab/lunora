import { describe, expect, it, vi } from "vitest";

import { createWorkflowContext } from "../src/create-workflow-context";
import type { WorkflowBindingLike, WorkflowInstanceLike } from "../src/types";

const fakeInstance = (id: string): WorkflowInstanceLike => {
    return {
        delete: async () => undefined,
        id,
        pause: async () => undefined,
        restart: async () => undefined,
        resume: async () => undefined,
        sendEvent: async () => undefined,
        status: async () => {
            return { status: "running" };
        },
        subscribe: async () => {
            return {
                next: async () => {
                    return { done: true, value: undefined };
                },
            };
        },
        terminate: async () => undefined,
    };
};

const fakeBinding = (): WorkflowBindingLike => {
    return {
        create: vi.fn<() => Promise<WorkflowInstanceLike>>(async () => fakeInstance("inst-1")),
        createBatch: vi.fn<() => Promise<WorkflowInstanceLike[]>>(async () => [fakeInstance("inst-1")]),
        deleteBatch: async (ids: ReadonlyArray<string>) => {
            return {
                deleted: ids.map((id) => {
                    return { id };
                }),
                errors: [],
            };
        },
        get: vi.fn<(id: string) => Promise<WorkflowInstanceLike>>(async (id: string) => fakeInstance(id)),
    };
};

describe("createWorkflowContext", () => {
    it("resolves declared workflows by their export key off env (a non-Cloudflare host)", async () => {
        expect.assertions(2);

        const binding = fakeBinding();
        const env = { OrderPipelineWorkflow: binding };

        const workflows = createWorkflowContext(env, [{ binding: "OrderPipelineWorkflow", exportName: "orderPipeline" }]);

        const created = await workflows.get("orderPipeline").create({ params: { orderId: "o1" } });

        expect(created.id).toBe("inst-1");
        expect(binding.create).toHaveBeenCalledWith({ params: { orderId: "o1" } });
    });

    it("prefers the invoking context's ctx.exports, where Cloudflare exposes exported workflows", async () => {
        expect.assertions(2);

        const exported = fakeBinding();
        const stale = fakeBinding();

        const workflows = createWorkflowContext({ OrderPipelineWorkflow: stale }, [{ binding: "OrderPipelineWorkflow", exportName: "orderPipeline" }], {
            OrderPipelineWorkflow: exported,
        });

        await workflows.get("orderPipeline").create({ params: {} });

        expect(exported.create).toHaveBeenCalledTimes(1);
        expect(stale.create).not.toHaveBeenCalled();
    });

    it("skips specs whose workflow is missing from exports and env, erroring lazily on use", () => {
        expect.assertions(1);

        const workflows = createWorkflowContext({}, [{ binding: "EtlWorkflow", exportName: "etl" }]);

        expect(() => workflows.get("etl")).toThrow(/no workflows are declared/);
    });

    it("ignores env values that are not Workflow bindings", () => {
        expect.assertions(1);

        const env = { EtlWorkflow: { create: 123 } };

        const workflows = createWorkflowContext(env, [{ binding: "EtlWorkflow", exportName: "etl" }]);

        expect(() => workflows.get("etl")).toThrow(/no workflows are declared/);
    });
});
