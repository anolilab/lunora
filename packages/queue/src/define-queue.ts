/**
 * `defineQueue` and the pure naming helpers shared by the runtime, codegen, and
 * the config layer. Everything here is Node-safe — no Cloudflare runtime imports
 * — so codegen and `@lunora/config` derive binding names and the stable wrangler
 * queue name from the exact same logic the runtime uses (mirrors
 * `defineWorkflow` / `defineContainer`).
 */
import type { QueueConfig, QueueDefinition } from "./types";

/**
 * The wrangler producer binding name for a queue export: `emailQueue` →
 * `QUEUE_EMAIL_QUEUE`, `email` → `QUEUE_EMAIL`. The `QUEUE_` prefix namespaces
 * these away from `SHARD`/`SESSION`/`SCHEDULER`/`WORKFLOW_*`/`CONTAINER_*` so a
 * queue export can never collide with the built-in bindings.
 */
const queueBindingName = (exportName: string): string => `QUEUE_${exportName.replaceAll(/(?<=[a-z0-9])(?=[A-Z])/g, "_").toUpperCase()}`;

/**
 * The stable queue name wrangler registers (`queues.producers[].queue` and
 * `queues.consumers[].queue`): `emailQueue` → `email-queue`. Used as the
 * deployed queue's identifier when no explicit `name` override is given.
 */
const queueDefaultName = (exportName: string): string => exportName.replaceAll(/(?<=[a-z0-9])(?=[A-Z])/g, "-").toLowerCase();

/**
 * Declare a Cloudflare Queue deployed alongside the app. Pure validation +
 * branding: codegen discovers the export, emits the typed `ctx.queues.<name>`
 * producer and (for push consumers) the worker `queue()` dispatch; the config
 * layer reconciles the wrangler `queues.producers[]` / `queues.consumers[]`
 * entries from the same definition.
 *
 * ```ts
 * // lunora/queues.ts
 * import { defineQueue } from "@lunora/queue";
 * import { api } from "./_generated/api";
 *
 * export const emailQueue = defineQueue<{ to: string }>({
 *     handler: async (ctx, batch) => {
 *         for (const message of batch.messages) {
 *             await ctx.run(api.email.send, { to: message.body.to });
 *             message.ack();
 *         }
 *     },
 * });
 * ```
 *
 * Enqueue from a mutation or action: `await ctx.queues.emailQueue.send({ to })`.
 *
 * ⚠️ **Privileged dispatch.** A push handler's `ctx.run(...)` calls back into
 * Lunora functions over the admin-authenticated dispatch endpoint (the same
 * trusted path the scheduler and workflows use), so those calls run with the
 * system identity — **end-user RLS is not applied**. Treat a queue handler as
 * trusted server code: validate `message.body` (it may be attacker-influenced if
 * anything user-facing can enqueue) before acting on it, and don't forward an
 * unchecked body straight into a privileged mutation.
 */
const defineQueue = <Body = unknown>(config: QueueConfig<Body>): QueueDefinition<Body> => {
    const mode = config.mode ?? "push";

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guards untrusted JS callers despite the typed union
    if (mode !== "push" && mode !== "pull") {
        throw new TypeError(`defineQueue: \`mode\` must be "push" or "pull" (got ${JSON.stringify(config.mode)})`);
    }

    if (mode === "push" && typeof config.handler !== "function") {
        throw new TypeError('defineQueue: `handler` must be a function for a push consumer (omit it only when `mode: "pull"`)');
    }

    if (config.name !== undefined && (typeof config.name !== "string" || config.name.length === 0)) {
        throw new TypeError("defineQueue: `name` must be a non-empty string when provided");
    }

    return { ...config, isLunoraQueue: true, mode };
};

/** True when a value is a `defineQueue` result (the runtime brand check). */
const isQueueDefinition = (value: unknown): value is QueueDefinition =>
    typeof value === "object" && value !== null && (value as { isLunoraQueue?: unknown }).isLunoraQueue === true;

export { defineQueue, isQueueDefinition, queueBindingName, queueDefaultName };
