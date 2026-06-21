/**
 * `defineStep` — author a reusable, schema-validated durable step. Pure
 * validation + branding (Node-safe, no Cloudflare runtime imports), mirroring
 * `defineWorkflow`. A step bundles an args-validator map, an optional `returns`
 * validator, the work to perform, and an optional rollback handler; run it from
 * a workflow body with `ctx.runStep(step, args)`, which validates the args
 * before the body runs and the result after, and forwards the rollback to
 * Cloudflare's native step rollback.
 */
import type { StepArgsValidator, StepConfig, StepDefinition } from "./types";

/**
 * Declare a reusable durable step. Same `args` map shape a Lunora `query` /
 * `mutation` / `action` uses, so a step reads like a function:
 *
 * ```ts
 * // lunora/steps.ts
 * import { defineStep } from "@lunora/workflow";
 * import { v } from "@lunora/values";
 *
 * export const fetchImage = defineStep("fetch image", {
 *     args: { imageKey: v.string() },
 *     returns: v.object({ data: v.bytes() }),
 *     handler: async (ctx, { imageKey }) => {
 *         const object = await (ctx.env.BUCKET as R2Bucket).get(imageKey);
 *         return { data: new Uint8Array(await object!.arrayBuffer()) };
 *     },
 *     rollback: async (ctx) => {
 *         await (ctx.env.BUCKET as R2Bucket).delete(`tmp/${ctx.args.imageKey}`);
 *     },
 * });
 * ```
 *
 * Then, inside a `defineWorkflow` handler:
 *
 * ```ts
 * const { data } = await ctx.runStep(fetchImage, { imageKey: ctx.params.imageKey });
 * ```
 */
const defineStep = <A extends StepArgsValidator, Result>(name: string, config: StepConfig<A, Result>): StepDefinition<A, Result> => {
    if (typeof name !== "string" || name.length === 0) {
        throw new TypeError("defineStep: `name` must be a non-empty string (the durable step label)");
    }

    // Runtime guard for untrusted JS callers, despite the required type. Read
    // through `unknown` so the `null` check is meaningful to the type-checker
    // (and the linters) rather than a statically-impossible comparison.
    const declaredArgs = config.args as unknown;

    if (typeof declaredArgs !== "object" || declaredArgs === null) {
        throw new TypeError("defineStep: `args` must be a validator map (e.g. `{ id: v.string() }`)");
    }

    if (typeof config.handler !== "function") {
        throw new TypeError("defineStep: `handler` must be a function (the step body)");
    }

    if (config.rollback !== undefined && typeof config.rollback !== "function") {
        throw new TypeError("defineStep: `rollback` must be a function when provided");
    }

    return {
        args: config.args,
        config: config.config,
        handler: config.handler,
        isLunoraStep: true,
        name,
        returns: config.returns,
        rollback: config.rollback,
        rollbackConfig: config.rollbackConfig,
    };
};

/** True when a value is a `defineStep` result (the runtime brand check). */
const isStepDefinition = (value: unknown): value is StepDefinition =>
    typeof value === "object" && value !== null && (value as { isLunoraStep?: unknown }).isLunoraStep === true;

export { defineStep, isStepDefinition };
