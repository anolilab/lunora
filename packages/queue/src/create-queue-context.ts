/**
 * `createQueueContext` — the codegen-facing factory that builds the `ctx.queues`
 * producer surface from the Worker `env` plus the binding specs emitted into
 * `_generated/shard.ts`. Mirrors `@lunora/workflow`'s `createWorkflowContext`:
 * codegen owns the spec list, this resolves each `env[binding]` and hands the
 * map to {@link createQueues}.
 *
 * Node-safe (structural binding types only) so it's unit-testable with
 * plain-object env doubles.
 */
import createQueues from "./create-queues";
import type { QueueBindingLike, QueueBindingSpec, Queues } from "./types";

/**
 * Build the `ctx.queues` map for a request: resolve every spec's `env[binding]`
 * into the `exportName → Queue binding` map and wrap it in {@link createQueues}.
 * A spec whose binding is absent from `env` is skipped here — the helpful "no
 * queue named …" error is raised lazily by `ctx.queues.<name>.send(...)` when
 * the missing queue is actually used.
 */
// eslint-disable-next-line import/prefer-default-export -- named export by package convention; the index re-exports it
export const createQueueContext = (env: Record<string, unknown>, specs: ReadonlyArray<QueueBindingSpec>): Queues => {
    const bindings: Record<string, QueueBindingLike> = {};

    for (const spec of specs) {
        const binding = env[spec.binding] as QueueBindingLike | undefined;

        if (binding && typeof binding.send === "function" && typeof binding.sendBatch === "function") {
            bindings[spec.exportName] = binding;
        }
    }

    return createQueues({ bindings });
};
