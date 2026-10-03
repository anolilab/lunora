/**
 * Minimal Node stub for the workerd-only `cloudflare:workers` module, wired by
 * the node project's alias (`vitest.config.ts`): the `DurableObject` base class
 * `BoxSessionDO` extends, and `WorkerEntrypoint`, mirroring the module's two
 * class exports — the same stub `packages/container` uses. Both just carry
 * `ctx` + `env`; the `workerd` project runs the real module.
 */
/* eslint-disable max-classes-per-file -- the stub must mirror both module-scope exports of `cloudflare:workers` */
class DurableObject<Env = unknown> {
    protected ctx: unknown;

    protected env: Env;

    public constructor(ctx: unknown, env: Env) {
        this.ctx = ctx;
        this.env = env;
    }
}

class WorkerEntrypoint<Env = unknown> {
    protected ctx: unknown;

    protected env: Env;

    public constructor(ctx: unknown, env: Env) {
        this.ctx = ctx;
        this.env = env;
    }
}

export { DurableObject, WorkerEntrypoint };
