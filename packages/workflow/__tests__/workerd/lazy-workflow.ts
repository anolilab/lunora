/**
 * A `lunora/workflows.ts`-style module the test worker reaches only through `import()`, the way a
 * `--lazy-functions` build's generated entrypoint loads the user's workflows on the first `run`.
 */
import { defineWorkflow } from "../../src/define-workflow";
import type { WorkflowDefinition } from "../../src/types";

const lazyWorkflow: WorkflowDefinition<{ orderId: string }, string> = defineWorkflow<{ orderId: string }, string>({
    handler: async (context) => context.step.do("load", () => Promise.resolve(`lazy:${context.params.orderId}`)),
});

export default lazyWorkflow;
