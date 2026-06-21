import { describe, expect, it, vi } from "vitest";

import createWorkflows from "../src/create-workflows";
import type { WorkflowBindingLike, WorkflowCreateOptions, WorkflowInstanceLike } from "../src/types";

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
        create: vi.fn<() => Promise<WorkflowInstanceLike>>(async () => fakeInstance("inst-1")),
        createBatch: vi.fn<(batch: ReadonlyArray<WorkflowCreateOptions>) => Promise<WorkflowInstanceLike[]>>(
            async (batch: ReadonlyArray<WorkflowCreateOptions>) =>
                batch.map((_: WorkflowCreateOptions, index: number) => fakeInstance(`inst-${String(index)}`)),
        ),
        get: vi.fn<(id: string) => Promise<WorkflowInstanceLike>>(async (id: string) => fakeInstance(id)),
    };
};

describe("createWorkflows", () => {
    it("resolves a handle and forwards create/get/createBatch", async () => {
        expect.assertions(5);

        const binding = fakeBinding();
        const workflows = createWorkflows({ bindings: { orderPipeline: binding } });

        const handle = workflows.get("orderPipeline");

        const created = await handle.create({ params: { orderId: "o1" } });

        expect(created.id).toBe("inst-1");
        expect(binding.create).toHaveBeenCalledWith({ params: { orderId: "o1" } });

        const got = await handle.get("inst-9");

        expect(got.id).toBe("inst-9");
        expect(binding.get).toHaveBeenCalledWith("inst-9");

        const batch = await handle.createBatch([{ params: {} }, { params: {} }]);

        expect(batch).toHaveLength(2);
    });

    it("throws a helpful error for an unknown workflow", () => {
        expect.assertions(1);

        const workflows = createWorkflows({ bindings: { orderPipeline: fakeBinding() } });

        expect(() => workflows.get("missing")).toThrow(/no workflow named "missing".*known workflows: orderPipeline/s);
    });

    it("reports when no workflows are declared", () => {
        expect.assertions(1);

        const workflows = createWorkflows({ bindings: {} });

        expect(() => workflows.get("anything")).toThrow(/no workflows are declared/);
    });
});
