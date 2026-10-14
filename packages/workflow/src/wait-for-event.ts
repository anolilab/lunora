/**
 * `ctx.waitForEvent` — the typed wrapper over Cloudflare's `step.waitForEvent`.
 * Takes a {@link WorkflowEventDefinition} rather than a `(name, { type })` string
 * pair, so the wire type is shared with the sender by construction, and parses the
 * delivered payload through the definition's validator before the workflow body
 * resumes on it.
 *
 * Node-safe (the native step API and the native `NonRetryableError` constructor are
 * injected), so the whole path is unit-testable with plain doubles.
 */
import { eventDefinitionProblem, RESERVED_EVENT_TYPE_PREFIX } from "./define-event";
import type { NativeNonRetryableErrorConstructor } from "./errors";
import { raiseNonRetryable } from "./errors";
import type { WaitForEventOptions, WorkflowEventDefinition, WorkflowStepLike, WorkflowWaitForEventFunction } from "./types";

/** Dependencies one workflow invocation's `ctx.waitForEvent` closes over. */
interface WaitForEventDeps {
    /** Native `cloudflare:workflows` `NonRetryableError` constructor — injected by `src/do`; absent in Node tests. */
    nonRetryableErrorClass?: NativeNonRetryableErrorConstructor;
    /** The native Cloudflare durable-step API. */
    step: WorkflowStepLike;
}

/**
 * Build `ctx.waitForEvent` for one workflow invocation.
 *
 * Every failure here is **non-retryable**. A malformed definition or a reserved
 * step name is a deterministic programmer error, and a payload that fails the
 * validator has already consumed the event — replaying the wait cannot produce a
 * different value, it can only hibernate the instance until its timeout. Each is
 * raised through the shared {@link raiseNonRetryable}, the same classification path
 * `ctx.runStep` uses, so the native error reaches Cloudflare and the instance fails
 * fast.
 */
const createWaitForEvent =
    (deps: WaitForEventDeps): WorkflowWaitForEventFunction =>
    async <Payload>(event: WorkflowEventDefinition<Payload>, options?: WaitForEventOptions): Promise<Payload> => {
        const problem = eventDefinitionProblem(event);

        if (problem !== undefined) {
            return raiseNonRetryable(`@lunora/workflow: ctx.waitForEvent ${problem}`, undefined, deps.nonRetryableErrorClass);
        }

        // The step-name namespace is reserved alongside the event-type namespace:
        // `lunora:await:*` / `lunora:signal:*` are the branch join's own durable
        // steps, and a user wait that borrowed one would collide with it.
        if (options?.name?.startsWith(RESERVED_EVENT_TYPE_PREFIX) === true) {
            return raiseNonRetryable(
                `@lunora/workflow: ctx.waitForEvent step name "${options.name}" is reserved — the "${RESERVED_EVENT_TYPE_PREFIX}" prefix is used by the framework's own steps`,
                undefined,
                deps.nonRetryableErrorClass,
            );
        }

        const received = await deps.step.waitForEvent(options?.name ?? `event:${event.type}`, { timeout: options?.timeout, type: event.type });

        try {
            return event.payload.parse(received.payload);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);

            return raiseNonRetryable(`@lunora/workflow: event "${event.type}" payload validation failed: ${message}`, error, deps.nonRetryableErrorClass);
        }
    };

// eslint-disable-next-line import/prefer-default-export -- named export by package convention; index.ts re-exports it
export { createWaitForEvent };
