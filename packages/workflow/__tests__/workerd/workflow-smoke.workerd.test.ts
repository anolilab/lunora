/**
 * Real-workerd boot smoke for `@lunora/workflow`.
 *
 * The Node unit suite exercises the context/dispatch glue against doubles;
 * this suite proves the generated-entrypoint shape actually runs on the real
 * Workflows engine (Miniflare-backed via `@cloudflare/vitest-plugin`).
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
import { describe, expect, it, vi } from "vitest";

import { BRANCH_MARKER_KEY } from "../../../../shared/branch-marker";
import createWorkflows from "../../src/create-workflows";
import type { WorkflowBindingLike } from "../../src/types";
import type { SmokeParams } from "./test-worker";
import { declineLog, rollbackLog } from "./test-worker";

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

    // A `409 DISPATCH_IN_PROGRESS` is the shard saying the step's own earlier
    // attempt is still running the call. Thrown out of the step, the engine
    // charges it as a failed attempt — so a call slower than the step's retry
    // ladder errored the instance while its work was still in flight. Handled
    // inside the step instead, it is waited out and never touches the budget.
    it("waits out a DISPATCH_IN_PROGRESS decline inside the step without spending its retry budget", async () => {
        expect.hasAssertions();

        const id = "decline-run-1";
        const instance = await introspectWorkflowInstance(env.WORKFLOW_DECLINE, id);

        declineLog.attempts.length = 0;
        declineLog.dispatches = 0;

        try {
            // Three declines against a step allowed two retries: every attempt the
            // engine has would be spent on a decline.
            await env.WORKFLOW_DECLINE.create({ id, params: { declines: 3 } });

            await instance.waitForStatus("complete");

            await expect(instance.getOutput()).resolves.toBe("charged");
            // COUNTS: the step body was entered once (attempt 1), and the one call
            // it made was re-checked until the origin answered.
            expect(declineLog.attempts).toStrictEqual([1]);
            expect(declineLog.dispatches).toBe(4);
        } finally {
            await instance.dispose();
        }
    }, 60_000);

    // The wait above can outlast a step's own `timeout`. Cut short by the engine,
    // the attempt fails either way, but the abandoned wait keeps re-dispatching
    // next to the retry. It has to end with the decline before the timeout, so
    // the attempt is charged once and nothing from it runs on afterwards.
    it("ends a decline wait before the step's timeout, so the attempt fails once and stops dispatching", async () => {
        expect.hasAssertions();

        const id = "timed-decline-run-1";
        const instance = await introspectWorkflowInstance(env.WORKFLOW_TIMED_DECLINE, id);

        declineLog.attempts.length = 0;
        declineLog.configs.length = 0;
        declineLog.dispatchedBy.length = 0;

        try {
            // Eight declines outlast two 6s attempts (each wait gives up 2s before
            // its timeout) and are gone by the third.
            await env.WORKFLOW_TIMED_DECLINE.create({ id, params: { declines: 8 } });

            await instance.waitForStatus("complete");

            await expect(instance.getOutput()).resolves.toBe("charged");
            // The engine hands the step its timeout, which is what the wait reads.
            expect(declineLog.configs).toHaveLength(3);
            expect(declineLog.configs).toStrictEqual(Array.from({ length: 3 }, () => expect.objectContaining({ timeout: "6 seconds" })));
            // COUNTS: attempts 1 and 2 each dispatched at +0s, +1s and +3s, then
            // gave up with the decline (keeping 1s of the 4s window for a last
            // dispatch); attempt 3 met the last two declines and was served on
            // its third call. No attempt dispatched after the next one began.
            expect(declineLog.attempts).toStrictEqual([1, 2, 3]);
            expect(declineLog.dispatchedBy).toStrictEqual([1, 1, 1, 2, 2, 2, 3, 3, 3]);
        } finally {
            await instance.dispose();
        }
    }, 60_000);

    // A rollback's decline wait is bounded by `rollbackConfig.timeout` because
    // of what this pins: the engine hands the rollback the FORWARD step's
    // config, not its own. If this ever reads "7 seconds", `run-step.ts` can go
    // back to reading `ctx.config`.
    it("hands a rollback the forward step's config, not its rollbackConfig", async () => {
        expect.hasAssertions();

        const id = "rollback-config-run-1";
        const instance = await introspectWorkflowInstance(env.WORKFLOW_ROLLBACK_CONFIG, id);

        rollbackLog.length = 0;

        try {
            await env.WORKFLOW_ROLLBACK_CONFIG.create({ id, params: {} });

            await vi.waitFor(
                () => {
                    expect(rollbackLog).toHaveLength(1);
                },
                { interval: 100, timeout: 20_000 },
            );

            expect(rollbackLog).toStrictEqual([expect.objectContaining({ timeout: "1 hour" })]);
        } finally {
            await instance.dispose();
        }
    }, 60_000);
});
