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

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * Shape-check the deploy settings (`schedules`, `limits`, `defaultRetention`)
 * for JS callers and values assembled at runtime. Codegen reads the same keys
 * statically (and validates each cron expression) before they reach wrangler;
 * this only keeps a malformed value from being carried silently on the
 * definition. Ranges — the 25,000-step ceiling, the plan's retention maximum —
 * are Cloudflare's to enforce at deploy, so they can move without a release.
 */
const workflowSettingsProblem = (config: Pick<WorkflowConfig, "defaultRetention" | "limits" | "schedules">): string | undefined => {
    // Read as `unknown`: the typed shape is exactly what an untrusted caller may not honour.
    const { defaultRetention, limits, schedules } = config as Record<"defaultRetention" | "limits" | "schedules", unknown>;
    const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

    if (schedules !== undefined && !(Array.isArray(schedules) && schedules.length > 0 && schedules.every((schedule) => isNonEmptyString(schedule)))) {
        return "`schedules` must be a non-empty array of cron expression strings";
    }

    const steps = isObject(limits) ? limits.steps : undefined;

    if (limits !== undefined && (!isObject(limits) || (steps !== undefined && !(Number.isInteger(steps) && (steps as number) > 0)))) {
        return "`limits` must be an object whose `steps` is a positive integer";
    }

    const durations = isObject(defaultRetention) ? [defaultRetention.errorRetention, defaultRetention.successRetention] : [];

    if (defaultRetention !== undefined && (!isObject(defaultRetention) || durations.some((value) => value !== undefined && !isNonEmptyString(value)))) {
        return '`defaultRetention` must be an object of duration strings (e.g. "7 days")';
    }

    return undefined;
};

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
 *         // A raw `step.do` retries its callback in place, so a WRITE made through
 *         // it needs an explicit dedup id (or use `ctx.runStep`, which pins one).
 *         await ctx.step.do("charge", () =>
 *             ctx.run(api.payments.charge, { orderId: ctx.params.orderId }, { dedupId: `charge:${ctx.params.orderId}` }),
 *         );
 *         return order;
 *     },
 *     // Deploy settings, written into the wrangler `workflows[]` entry.
 *     schedules: ["0 * * * *"],
 *     limits: { steps: 25_000 },
 *     defaultRetention: { successRetention: "3 days", errorRetention: "30 days" },
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

    const settingsProblem = workflowSettingsProblem(config);

    if (settingsProblem !== undefined) {
        throw new TypeError(`defineWorkflow: ${settingsProblem}`);
    }

    return { ...config, isLunoraWorkflow: true };
};

/** True when a value is a `defineWorkflow` result (the runtime brand check). */
const isWorkflowDefinition = (value: unknown): value is WorkflowDefinition =>
    typeof value === "object" && value !== null && (value as { isLunoraWorkflow?: unknown }).isLunoraWorkflow === true;

export { defineWorkflow, isWorkflowDefinition, workflowBindingName, workflowClassName, workflowDefaultName };
