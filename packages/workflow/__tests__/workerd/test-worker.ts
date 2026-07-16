/**
 * Test entry-point Worker for `@lunora/workflow` workerd integration tests.
 *
 * Mirrors what codegen emits in `_generated/workflows.ts` for a project with
 * one `defineWorkflow` export: a one-line `WorkflowEntrypoint` subclass over
 * the `LunoraWorkflow` base (`@lunora/workflow/do`), registered under the
 * wrangler `workflows[]` class name.
 */
import type { WorkflowEntrypoint } from "cloudflare:workers";

import { defineWorkflow } from "../../src/define-workflow";
import LunoraWorkflow from "../../src/do";

interface SmokeParams {
    orderId: string;
}

interface SmokeOutput {
    charged: string;
    loaded: string;
}

interface Env {
    WORKFLOW_SMOKE: Workflow<SmokeParams>;
}

/**
 * The `lunora/workflows.ts`-style export under test: two named durable steps
 * chained through the Lunora run context (`ctx.params` + native `ctx.step.do`).
 */
const smokeWorkflow = defineWorkflow<SmokeParams, SmokeOutput>({
    handler: async (context) => {
        const loaded = await context.step.do("load", () => Promise.resolve(`order:${context.params.orderId}`));
        const charged = await context.step.do("charge", () => Promise.resolve(`${loaded}:charged`));

        return { charged, loaded };
    },
});

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
export { SmokeWorkflow, smokeWorkflow };
export type { Env, SmokeOutput, SmokeParams };
