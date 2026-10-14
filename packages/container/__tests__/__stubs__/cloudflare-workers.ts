/**
 * Minimal Node stub for the workerd-only `cloudflare:workers` module, wired
 * via a vitest alias. Only what `@cloudflare/containers` touches at module
 * scope: the `DurableObject` base class and `WorkerEntrypoint` (its
 * `ContainerProxy` extends it), both just carrying `ctx` + `env`, and the
 * `RpcTarget` marker class a spawned process's control stub extends.
 */
/* eslint-disable max-classes-per-file -- the stub must mirror module-scope exports of `cloudflare:workers` */
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

// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- mirrors the runtime's empty marker class
class RpcTarget {}

export { DurableObject, RpcTarget, WorkerEntrypoint };
