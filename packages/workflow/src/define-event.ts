/**
 * `defineWorkflowEvent` — declare an external event a workflow can wait on.
 *
 * Cloudflare matches `instance.sendEvent({ type })` against
 * `step.waitForEvent(name, { type })` by a bare string, and the payload crosses
 * as `unknown`. Both ends therefore drift silently: a typo'd type hibernates the
 * instance until its (24h default) timeout with no error anywhere, and a payload
 * that changed shape resumes the workflow on garbage. A definition makes the type
 * and payload shape one value both ends import — no literal to typo, no second
 * place to update on a rename — and the payload is parsed on send and on receive.
 *
 * Pure validation + branding (Node-safe, no Cloudflare runtime imports), mirroring
 * `defineWorkflow` / `defineStep`.
 */
import type { Validator } from "@lunora/values";

import type { WorkflowEventDefinition } from "./types";

/**
 * The event-type namespace the framework reserves for its own instance-to-instance
 * protocol — today the `ctx.parallel` branch join, whose `lunora:branch:<childId>`
 * types are derived from this prefix (see `fan-out.ts`). A user event here could be
 * mistaken for a branch outcome, so it is rejected both at declaration and at the
 * send boundary.
 *
 * This covers the *workflow* package's protocol only. `@lunora/agent` runs its own
 * unprefixed event types over its own bindings and is unaffected either way.
 */
const RESERVED_EVENT_TYPE_PREFIX = "lunora:";

/**
 * Why `value` cannot be used as an event definition, or `undefined` when it can.
 *
 * Returns the reason rather than throwing so each boundary can raise its own error
 * type: a `TypeError` while authoring, a `BAD_REQUEST` in a caller's request, a
 * `NonRetryableError` inside a durable replay. The brand alone is not enough —
 * `WorkflowEventDefinition` is a public interface with a boolean brand, so a
 * hand-built object reaches the wire unless the fields are checked too.
 */
const eventDefinitionProblem = (value: unknown): string | undefined => {
    if (typeof value !== "object" || value === null || (value as { isLunoraWorkflowEvent?: unknown }).isLunoraWorkflowEvent !== true) {
        return "expects a `defineWorkflowEvent` definition";
    }

    const candidate = value as { payload?: { parse?: unknown }; type?: unknown };

    if (typeof candidate.type !== "string" || candidate.type.length === 0) {
        return "event `type` must be a non-empty string";
    }

    if (candidate.type.startsWith(RESERVED_EVENT_TYPE_PREFIX)) {
        return `event type "${candidate.type}" is reserved — the "${RESERVED_EVENT_TYPE_PREFIX}" prefix is used by the framework's own events`;
    }

    if (typeof candidate.payload?.parse !== "function") {
        return "event `payload` must be a validator (e.g. `v.object({ ok: v.boolean() })`)";
    }

    return undefined;
};

/**
 * Declare an external event, its wire type, and its payload shape.
 *
 * ```ts
 * // lunora/events.ts
 * import { defineWorkflowEvent } from "@lunora/workflow";
 * import { v } from "@lunora/values";
 *
 * export const orderApproved = defineWorkflowEvent("order-approved", v.object({ approvedBy: v.string() }));
 * ```
 *
 * Wait on it inside a workflow body — the payload is typed and validated:
 *
 * ```ts
 * const { approvedBy } = await ctx.waitForEvent(orderApproved, { name: "await approval", timeout: "7 days" });
 * ```
 *
 * …and send it from a mutation/action with the same definition:
 *
 * ```ts
 * await ctx.workflows.get("orderPipeline").sendEvent(instanceId, orderApproved, { approvedBy });
 * ```
 */
const defineWorkflowEvent = <Payload>(type: string, payload: Validator<Payload>): WorkflowEventDefinition<Payload> => {
    if (typeof type !== "string" || type.length === 0) {
        throw new TypeError("defineWorkflowEvent: `type` must be a non-empty string (the wire event type)");
    }

    const problem = eventDefinitionProblem({ isLunoraWorkflowEvent: true, payload, type });

    if (problem !== undefined) {
        throw new TypeError(`defineWorkflowEvent: ${problem}`);
    }

    return { isLunoraWorkflowEvent: true, payload, type };
};

/** True when a value is a `defineWorkflowEvent` result (the runtime brand check). */
const isWorkflowEventDefinition = (value: unknown): value is WorkflowEventDefinition =>
    typeof value === "object" && value !== null && (value as { isLunoraWorkflowEvent?: unknown }).isLunoraWorkflowEvent === true;

export { defineWorkflowEvent, eventDefinitionProblem, isWorkflowEventDefinition, RESERVED_EVENT_TYPE_PREFIX };
