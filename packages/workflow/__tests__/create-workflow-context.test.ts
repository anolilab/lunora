import { describe, expect, it, vi } from "vitest";

import { createWorkflowContext } from "../src/create-workflow-context";
import type { WorkflowBindingLike, WorkflowInstanceLike } from "../src/types";

const fakeInstance = (id: string): WorkflowInstanceLike => {
    return {
        id,
        pause: async () => undefined,
        restart: async () => undefined,
        resume: async () => undefined,
        sendEvent: async () => undefined,
        status: async () => {
            return { status: "running" };
        },
        terminate: async () => undefined,
    };
};

const fakeBinding = (): WorkflowBindingLike => {
    return {
        create: vi.fn(async () => fakeInstance("inst-1")),
        createBatch: vi.fn(async () => [fakeInstance("inst-1")]),
        get: vi.fn(async (id: string) => fakeInstance(id)),
    };
};

describe("createWorkflowContext", () => {
    it("resolves declared workflows from env by their binding name", async () => {
        const binding = fakeBinding();
        const env = { WORKFLOW_ORDER_PIPELINE: binding };

        const workflows = createWorkflowContext(env, [{ binding: "WORKFLOW_ORDER_PIPELINE", exportName: "orderPipeline" }]);

        const created = await workflows.get("orderPipeline").create({ params: { orderId: "o1" } });

        expect(created.id).toBe("inst-1");
        expect(binding.create).toHaveBeenCalledWith({ params: { orderId: "o1" } });
    });

    it("skips specs whose binding is missing from env, erroring lazily on use", () => {
        const workflows = createWorkflowContext({}, [{ binding: "WORKFLOW_ETL", exportName: "etl" }]);

        expect(() => workflows.get("etl")).toThrow(/no workflows are declared/);
    });

    it("ignores env values that are not Workflow bindings", () => {
        const env = { WORKFLOW_ETL: { create: 123 } };

        const workflows = createWorkflowContext(env, [{ binding: "WORKFLOW_ETL", exportName: "etl" }]);

        expect(() => workflows.get("etl")).toThrow(/no workflows are declared/);
    });
});
