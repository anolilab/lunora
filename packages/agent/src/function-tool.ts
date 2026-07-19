import { LunoraError } from "@lunora/errors";
import type { FlexibleSchema } from "ai";

import { toFunctionReference } from "./paths";
import type { AgentFunctionReference, AgentToolDefinition } from "./types";

/**
 * Author-supplied config for {@link functionTool}.
 * @experimental
 */
interface FunctionToolOptions<Input> {
    /** What the tool does — shown to the model (the model decides from it). */
    description: string;
    /** The input schema shown to the model (a zod schema or `jsonSchema(...)`). */
    inputSchema: FlexibleSchema<Input>;
}

/**
 * Expose any Lunora query/mutation/action as an agent tool. The returned
 * definition's `execute` dispatches the referenced function through the loop's
 * existing `run` seam (the workflow `ctx.run`) — so there is no bespoke wrapper
 * per tool, and the call runs inside the loop's named durable step exactly like
 * any other tool.
 *
 * ```ts
 * import { functionTool } from "@lunora/agent";
 * import { api } from "./_generated/api";
 *
 * export const support = defineAgent({
 *     model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
 *     tools: {
 *         lookupOrder: functionTool(api.orders.byId, {
 *             description: "Look up an order by its id.",
 *             inputSchema: jsonSchema({ properties: { id: { type: "string" } }, required: ["id"], type: "object" }),
 *         }),
 *     },
 * });
 * ```
 *
 * The function reference may be a typed `api.*` reference or a `"module:name"`
 * path. The model-provided input is passed verbatim as the function's args, so
 * `inputSchema` should mirror the referenced function's argument validator.
 * @experimental
 */
const functionTool = <Input extends Record<string, unknown> = Record<string, unknown>, Output = unknown>(
    reference: AgentFunctionReference | string,
    options: FunctionToolOptions<Input>,
): AgentToolDefinition<Input, Output> => {
    if (typeof options.description !== "string" || options.description.length === 0) {
        throw new LunoraError("INTERNAL", "@lunora/agent: functionTool requires a non-empty `description` (the model decides from it)");
    }

    // The cast widens away the required type so the runtime guard survives a JS
    // caller that omits `inputSchema` (the type marks it required, but nothing
    // enforces that at the untyped boundary).
    if ((options.inputSchema as FlexibleSchema<Input> | undefined) === undefined) {
        throw new LunoraError("INTERNAL", "@lunora/agent: functionTool requires an `inputSchema` (a zod schema or `jsonSchema(...)`)");
    }

    const target = toFunctionReference(reference);

    return {
        description: options.description,
        execute: (input, context) => context.run(target, input) as Promise<Output>,
        inputSchema: options.inputSchema,
        isLunoraAgentTool: true,
    };
};

export type { FunctionToolOptions };
export { functionTool };
