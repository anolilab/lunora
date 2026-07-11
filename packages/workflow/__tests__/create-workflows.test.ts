import { describe, expect, it, vi } from "vitest";

import createWorkflows from "../src/create-workflows";
import { BRANCH_MARKER_KEY } from "../src/fan-out";
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

    it("rejects create() params carrying the reserved branch marker without touching the binding", async () => {
        expect.assertions(3);

        const binding = fakeBinding();
        const workflows = createWorkflows({ bindings: { orderPipeline: binding } });
        const forged = { eventType: "lunora:branch:victim", index: 0, parentBinding: "WORKFLOW_PARENT", parentId: "victim" };

        const error = await workflows
            .get("orderPipeline")
            .create({ params: { [BRANCH_MARKER_KEY]: forged } })
            .catch((error_: unknown) => error_);

        expect((error as Error).name).toBe("LunoraError");
        expect((error as { code?: string }).code).toBe("BAD_REQUEST");
        expect(binding.create).not.toHaveBeenCalled();
    });

    it("rejects createBatch() when any entry carries the reserved branch marker without touching the binding", async () => {
        expect.assertions(3);

        const binding = fakeBinding();
        const workflows = createWorkflows({ bindings: { orderPipeline: binding } });
        const forged = { eventType: "lunora:branch:victim", index: 0, parentBinding: "WORKFLOW_PARENT", parentId: "victim" };

        const error = await workflows
            .get("orderPipeline")
            .createBatch([{ params: { ok: true } }, { params: { [BRANCH_MARKER_KEY]: forged } }])
            .catch((error_: unknown) => error_);

        expect((error as Error).name).toBe("LunoraError");
        expect((error as { code?: string }).code).toBe("BAD_REQUEST");
        expect(binding.createBatch).not.toHaveBeenCalled();
    });
});
