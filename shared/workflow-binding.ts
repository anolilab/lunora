/**
 * Resolve a Lunora workflow (or agent) by its export key — the generated
 * `WorkflowEntrypoint` class name, e.g. `OrderPipelineWorkflow`.
 *
 * On Cloudflare the class is declared in wrangler's `exports` (not a
 * `workflows[]` binding), so it is reached through the invoking context's
 * `ctx.exports` — a Worker's `ExecutionContext`, a Durable Object's
 * `DurableObjectState` and a `WorkflowEntrypoint`'s `ctx` all carry it. A host
 * without workflow exports binds the same class on `env` under the same key
 * instead (celld's config projection writes a `workflows[]` binding named after
 * the class; the Node host sets it directly).
 *
 * `env` is consulted FIRST: on Cloudflare nothing is bound on `env` under a
 * class name, so the lookup still lands on `ctx.exports` there, while on a host
 * that binds the class explicitly that binding wins over whatever loopback stub
 * its `ctx.exports` might also expose.
 *
 * Zero-dependency and bundler-inlined (see `shared/`), because the scheduler,
 * the runtime and the shard DO resolve workflows without depending on
 * `@lunora/workflow`.
 */
const resolveWorkflowBinding = (env: unknown, exports: unknown, key: string): unknown =>
    (env as Record<string, unknown> | null | undefined)?.[key] ?? (exports as Record<string, unknown> | null | undefined)?.[key];

/** The Workflow binding methods a caller can require of what {@link resolveWorkflowHandle} finds. */
type WorkflowMethod = "create" | "createBatch" | "get";

/**
 * {@link resolveWorkflowBinding}, narrowed: the binding when it carries every
 * method in `required`, else `undefined` — so each caller keeps only its own
 * error message rather than restating the shape check.
 */
const resolveWorkflowHandle = <Handle>(env: unknown, exports: unknown, key: string, required: ReadonlyArray<WorkflowMethod>): Handle | undefined => {
    const binding = resolveWorkflowBinding(env, exports, key);

    if (typeof binding !== "object" || binding === null) {
        return undefined;
    }

    return required.every((method) => typeof (binding as Record<string, unknown>)[method] === "function") ? (binding as Handle) : undefined;
};

export type { WorkflowMethod };
export { resolveWorkflowBinding, resolveWorkflowHandle };
