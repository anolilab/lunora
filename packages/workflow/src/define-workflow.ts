/**
 * `defineWorkflow` and the pure naming helpers shared by the runtime, codegen,
 * and the config layer. Everything here is Node-safe — no Cloudflare runtime
 * imports — so codegen and `@lunora/config` derive class names and binding names
 * from the exact same logic the runtime uses (mirrors `defineContainer`).
 */
import type { WorkflowConfig, WorkflowDefinition } from "./types";

/**
 * The generated `WorkflowEntrypoint` class name for a `lunora/workflows.ts`
 * export: `orderPipeline` → `OrderPipelineWorkflow`. wrangler's
 * `workflows[].class_name` references it, so codegen and the config layer MUST
 * derive it identically — always via this helper.
 */
const workflowClassName = (exportName: string): string => `${exportName.charAt(0).toUpperCase()}${exportName.slice(1)}Workflow`;

/**
 * The wrangler binding name for a workflow export: `orderPipeline` →
 * `WORKFLOW_ORDER_PIPELINE`, `etl` → `WORKFLOW_ETL`. The `WORKFLOW_` prefix
 * namespaces these away from `SHARD`/`SESSION`/`SCHEDULER`/`CONTAINER_*` so a
 * workflow export can never collide with the built-in bindings.
 */
const workflowBindingName = (exportName: string): string => `WORKFLOW_${exportName.replaceAll(/(?<=[a-z0-9])(?=[A-Z])/g, "_").toUpperCase()}`;

/**
 * The stable workflow name wrangler registers (`workflows[].name`):
 * `orderPipeline` → `order-pipeline`. Used as the deployed workflow's
 * identifier when no explicit `name` override is given.
 */
const workflowDefaultName = (exportName: string): string => exportName.replaceAll(/(?<=[a-z0-9])(?=[A-Z])/g, "-").toLowerCase();

/**
 * Declare a durable workflow deployed alongside the app. Pure validation +
 * branding: codegen discovers the export, emits the `WorkflowEntrypoint`
 * subclass (`_generated/workflows.ts`), and wires the typed `ctx.workflows`
 * handle; the config layer reconciles the wrangler `workflows[]` entry from the
 * same definition.
 *
 * ```ts
 * // lunora/workflows.ts
 * import { defineWorkflow } from "@lunora/workflow";
 * import { api } from "./_generated/api";
 *
 * export const orderPipeline = defineWorkflow<{ orderId: string }>({
 *     handler: async (ctx) => {
 *         const order = await ctx.step.do("load", () => ctx.run(api.orders.get, { id: ctx.params.orderId }));
 *         await ctx.step.sleep("cool-off", "1 minute");
 *         await ctx.step.do("charge", () => ctx.run(api.payments.charge, { orderId: ctx.params.orderId }));
 *         return order;
 *     },
 * });
 * ```
 */
const defineWorkflow = <Params = Record<string, unknown>, Output = unknown>(config: WorkflowConfig<Params, Output>): WorkflowDefinition<Params, Output> => {
    if (typeof config.handler !== "function") {
        throw new TypeError("defineWorkflow: `handler` must be a function (the workflow body)");
    }

    if (config.name !== undefined && (typeof config.name !== "string" || config.name.length === 0)) {
        throw new TypeError("defineWorkflow: `name` must be a non-empty string when provided");
    }

    return { ...config, isLunoraWorkflow: true };
};

/** True when a value is a `defineWorkflow` result (the runtime brand check). */
const isWorkflowDefinition = (value: unknown): value is WorkflowDefinition =>
    typeof value === "object" && value !== null && (value as { isLunoraWorkflow?: unknown }).isLunoraWorkflow === true;

export { defineWorkflow, isWorkflowDefinition, workflowBindingName, workflowClassName, workflowDefaultName };
