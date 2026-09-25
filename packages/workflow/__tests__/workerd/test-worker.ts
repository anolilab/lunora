/**
 * Test entry-point Worker for `@lunora/workflow` workerd integration tests.
 *
 * Mirrors what codegen emits in `_generated/workflows.ts` for a project with
 * one `defineWorkflow` export: a one-line `WorkflowEntrypoint` subclass over
 * the `LunoraWorkflow` base (`@lunora/workflow/do`), registered under the
 * wrangler `workflows[]` class name.
 */
import { LunoraError, toErrorBody } from "@lunora/errors";
import type { WorkflowEntrypoint } from "cloudflare:workers";

import { defineStep } from "../../src/define-step";
import { defineWorkflow } from "../../src/define-workflow";
import LunoraWorkflow from "../../src/do";
import type { WorkflowDefinition } from "../../src/types";

interface SmokeParams {
    orderId: string;
}

interface SmokeOutput {
    charged: string;
    loaded: string;
}

interface Env {
    WORKFLOW_DECLINE: Workflow<DeclineParams>;
    WORKFLOW_SMOKE: Workflow<SmokeParams>;
    WORKFLOW_TIMED_DECLINE: Workflow<DeclineParams>;
}

interface DeclineParams {
    /** How many dispatches the origin declines with `409 DISPATCH_IN_PROGRESS` before it answers. */
    declines: number;
}

/**
 * The `lunora/workflows.ts`-style export under test: two named durable steps
 * chained through the Lunora run context (`ctx.params` + native `ctx.step.do`).
 */
const smokeWorkflow: WorkflowDefinition<SmokeParams, SmokeOutput> = defineWorkflow<SmokeParams, SmokeOutput>({
    handler: async (context) => {
        const loaded = await context.step.do("load", () => Promise.resolve(`order:${context.params.orderId}`));
        const charged = await context.step.do("charge", () => Promise.resolve(`${loaded}:charged`));

        return { charged, loaded };
    },
});

/**
 * What the dispatch origin saw and what the step body saw, for assertions: one
 * entry per `ctx.run` POST, and the engine's attempt number on every entry into
 * the step body.
 */
const declineLog = {
    attempts: [] as number[],
    /** The step config the engine handed each attempt of the timed step. */
    configs: [] as unknown[],
    dispatches: 0,
    /** For the timed step: the attempt that made each dispatch, in arrival order. */
    dispatchedBy: [] as number[],
};

/**
 * The worker's `/_lunora/scheduler/dispatch` hop, answered in-process. It
 * declines the first `declines` calls exactly the way `ShardDO` declines a
 * re-delivery whose first attempt is still running, then serves the result.
 */
const origin = { pendingDeclines: 0 };

const originFetch = async (request: Request): Promise<Response> => {
    const { args } = await request.json<{ args?: { attempt?: number } }>();

    declineLog.dispatches += 1;

    if (typeof args?.attempt === "number") {
        declineLog.dispatchedBy.push(args.attempt);
    }

    if (origin.pendingDeclines > 0) {
        origin.pendingDeclines -= 1;

        const { body, status } = toErrorBody(new LunoraError("DISPATCH_IN_PROGRESS", "a dispatch carrying this idempotency id is already running"));

        // The header only the shard's claim path sets — what makes this a decline and not a handler error.
        return Response.json({ error: body }, { headers: { "x-lunora-dispatch-declined": "1" }, status });
    }

    return Response.json({ result: "charged" });
};

const realFetch = globalThis.fetch.bind(globalThis);

// Route `https://origin.test` (the `LUNORA_ORIGIN_URL` var) to `originFetch`;
// everything else reaches the real `fetch`. Installed once, at module scope:
// the engine runs the entrypoint in this isolate, so the dispatch its `ctx.run`
// makes goes through this module's global `fetch`.
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);

    return new URL(request.url).origin === "https://origin.test" ? originFetch(request) : realFetch(request);
};

/** One durable step whose only work is a `ctx.run`, with a small, fast retry budget so an exhausted budget shows up in seconds. */
const chargeStep = defineStep("charge", {
    args: {},
    config: { retries: { backoff: "constant", delay: "1 second", limit: 2 } },
    handler: async (context) => {
        declineLog.attempts.push(context.attempt);

        return context.run({ __lunoraRef: "orders:slowCharge" });
    },
});

const declineWorkflow: WorkflowDefinition<DeclineParams> = defineWorkflow<DeclineParams>({
    handler: async (context) => {
        origin.pendingDeclines = context.params.declines;

        return context.runStep(chargeStep, {});
    },
});

/**
 * The same call in a step whose `timeout` (6s) is shorter than the declines
 * last. Each dispatch names the attempt that made it, so a wait that outlives
 * its attempt shows up as an earlier attempt dispatching after a later one.
 */
const timedChargeStep = defineStep("timed-charge", {
    args: {},
    config: { retries: { backoff: "constant", delay: "1 second", limit: 2 }, timeout: "6 seconds" },
    handler: async (context) => {
        declineLog.attempts.push(context.attempt);
        declineLog.configs.push(context.config);

        return context.run({ __lunoraRef: "orders:slowCharge" }, { attempt: context.attempt });
    },
});

const timedDeclineWorkflow: WorkflowDefinition<DeclineParams> = defineWorkflow<DeclineParams>({
    handler: async (context) => {
        origin.pendingDeclines = context.params.declines;

        return context.runStep(timedChargeStep, {});
    },
});

class TimedDeclineWorkflow extends LunoraWorkflow<DeclineParams> {
    public constructor(context: ConstructorParameters<typeof WorkflowEntrypoint>[0], env: Record<string, unknown>) {
        super(context, env, timedDeclineWorkflow, "timedDeclineWorkflow");
    }
}

class DeclineWorkflow extends LunoraWorkflow<DeclineParams> {
    public constructor(context: ConstructorParameters<typeof WorkflowEntrypoint>[0], env: Record<string, unknown>) {
        super(context, env, declineWorkflow, "declineWorkflow");
    }
}

/** The generated one-line entrypoint subclass, exactly as codegen emits it. */
class SmokeWorkflow extends LunoraWorkflow<SmokeParams, SmokeOutput> {
    public constructor(context: ConstructorParameters<typeof WorkflowEntrypoint>[0], env: Record<string, unknown>) {
        super(context, env, smokeWorkflow, "smokeWorkflow");
    }
}

const testWorker = {
    fetch(_request: Request, _env: Env): Response {
        return new Response("workflow-test-worker", { status: 200 });
    },
};

export default testWorker;
export { declineLog, DeclineWorkflow, SmokeWorkflow, smokeWorkflow, TimedDeclineWorkflow };
export type { DeclineParams, Env, SmokeOutput, SmokeParams };
