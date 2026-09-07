/**
 * Durable Workflows — added by `lunora add workflow`.
 *
 * Declare durable, long-running workflows with `defineWorkflow`. Codegen
 * discovers exports from this file and generates:
 *   - A typed `ctx.workflows.get("<name>")` overload on mutation/action ctx
 *   - A generated WorkflowEntrypoint subclass in the Worker entry
 *   - wrangler.jsonc workflows[] entries (auto-reconciled)
 *
 * Workflows are persisted, retried, and observable — ideal for order
 * processing, onboarding flows, data pipelines, and multi-step actions.
 *
 * Usage (from a mutation):
 *   const instance = await ctx.workflows.get("orderPipeline").create({ params: { orderId: "ord_123" } });
 *   const status = await instance.status();
 */
import { defineWorkflow } from "@lunora/workflow";

/**
 * A sample order-processing workflow. Each `step.do` is a durable, retried
 * unit of work; `step.sleep` pauses without costing CPU.
 */
export const orderPipeline = defineWorkflow<{ orderId: string }, { status: string }>({
    handler: async (ctx) => {
        // Step 1: Load the order (retried on failure)
        await ctx.step.do("load-order", async () => {
            // ctx.run dispatches a Lunora function (query/mutation/action)
            // return await ctx.run(api.orders.get, { id: ctx.params.orderId });
            return { id: ctx.params.orderId, total: 2999 };
        });

        // Step 2: Wait for external processing
        await ctx.step.sleep("cool-off", "30 seconds");

        // Step 3: Charge the customer
        await ctx.step.do("charge", async () => {
            // return await ctx.run(api.payments.charge, { orderId: ctx.params.orderId });
        });

        return { status: "completed" };
    },
});
