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
 * the class; the Node host sets it directly), so one lookup serves every target.
 *
 * Zero-dependency and bundler-inlined (see `shared/`), because the scheduler,
 * the runtime and the shard DO resolve workflows without depending on
 * `@lunora/workflow`.
 */
const resolveWorkflowBinding = (env: unknown, exports: unknown, key: string): unknown =>
    (exports as Record<string, unknown> | null | undefined)?.[key] ?? (env as Record<string, unknown> | null | undefined)?.[key];

export { resolveWorkflowBinding };
