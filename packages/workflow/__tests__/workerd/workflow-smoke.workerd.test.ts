/**
 * Real-workerd boot smoke for `@lunora/workflow`.
 *
 * The Node unit suite exercises the context/dispatch glue against doubles;
 * this suite proves the generated-entrypoint shape actually runs on the real
 * Workflows engine (Miniflare-backed via `@cloudflare/vitest-pool-workers`).
 * Covered: the `LunoraWorkflow`-based `WorkflowEntrypoint` subclass boots in
 * workerd and executes its named durable steps to completion; the typed
 * `ctx.workflows` binding surface (`createWorkflows`) creates and reads
 * instances through a real `Workflow` binding; and the `__lunoraBranch`
 * reserved-params guard plus the unknown-name error fire at the real binding
 * boundary.
 *
 * Boundary: `ctx.run` (Lunora function dispatch from inside a step) needs a
 * running Lunora origin worker + admin bearer, so the smoke handler sticks to
 * native `step.do` work — the dispatch runner itself is covered by the Node
 * suite and `@lunora/dispatch`'s own tests.
 */
import { env, introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { BRANCH_MARKER_KEY } from "../../../../shared/branch-marker";
import createWorkflows from "../../src/create-workflows";
import type { WorkflowBindingLike } from "../../src/types";
import type { SmokeParams } from "./test-worker";

const workflows = createWorkflows({ bindings: { smokeWorkflow: env.WORKFLOW_SMOKE as unknown as WorkflowBindingLike } });

describe("@lunora/workflow (workerd)", () => {
    it("runs a generated LunoraWorkflow entrypoint to completion on the real engine", async () => {
        expect.hasAssertions();

        const id = "smoke-run-1";
        const instance = await introspectWorkflowInstance(env.WORKFLOW_SMOKE, id);

        try {
            const handle = workflows.get<SmokeParams>("smokeWorkflow");
            const created = await handle.create({ id, params: { orderId: "42" } });

            expect(created.id).toBe(id);

            await instance.waitForStatus("complete");

            // Both named durable steps ran, in order, with the params threaded
            // through the Lunora run context.
            await expect(instance.waitForStepResult({ name: "load" })).resolves.toBe("order:42");
            await expect(instance.waitForStepResult({ name: "charge" })).resolves.toBe("order:42:charged");
            await expect(instance.getOutput()).resolves.toEqual({ charged: "order:42:charged", loaded: "order:42" });
        } finally {
            await instance.dispose();
        }
    });

    it("ctx.workflows.get(name).get(id) reads a real instance's status", async () => {
        expect.hasAssertions();

        const id = "smoke-run-2";
        const instance = await introspectWorkflowInstance(env.WORKFLOW_SMOKE, id);

        try {
            const handle = workflows.get<SmokeParams>("smokeWorkflow");

            await handle.create({ id, params: { orderId: "7" } });
            await instance.waitForStatus("complete");

            const fetched = await handle.get(id);
            const status = await fetched.status();

            expect(fetched.id).toBe(id);
            expect(status.status).toBe("complete");
        } finally {
            await instance.dispose();
        }
    });

    it("rejects the reserved branch-marker key at the real binding boundary", async () => {
        expect.hasAssertions();

        const handle = workflows.get("smokeWorkflow");

        await expect(handle.create({ params: { [BRANCH_MARKER_KEY]: { forged: true } } })).rejects.toThrow(
            /may not contain the reserved workflow branch-marker key/,
        );
    });

    it("throws a directed error for an undeclared workflow name", () => {
        expect.hasAssertions();

        expect(() => workflows.get("nope")).toThrow(/no workflow named "nope".*known workflows: smokeWorkflow/);
    });
});
