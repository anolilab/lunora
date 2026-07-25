/**
 * Test worker for the composed Cloudflare platform.
 *
 * The point of this harness is that the conformance suite runs against the
 * **assembled** host — the same `createShardPlatform` / `createWorkerPlatform`
 * an app calls — rather than against individually hand-wired adapters. That is
 * what makes the scheduler leg meaningful: a real `SchedulerDO` is bound here,
 * so `SchedulerHost.schedule` / `.cancel` exercise durable storage and alarms
 * instead of being reported as an unimplemented gap.
 */
import { SchedulerDO } from "@lunora/scheduler";
import { DurableObject } from "cloudflare:workers";

interface Env {
    ECHO: DurableObjectNamespace<TestEchoDO>;
    LUNORA_ORIGIN_URL?: string;
    SCHEDULER: DurableObjectNamespace<TestSchedulerDO>;
    SHARD: DurableObjectNamespace<TestShardDO>;
}

/**
 * A bare Durable Object whose state the suite composes the shard-scoped
 * contracts from. It deliberately runs no engine: the contracts under test are
 * the host's, not `ShardDO`'s.
 */
class TestShardDO extends DurableObject<Env> {
    // eslint-disable-next-line class-methods-use-this -- a stub target: the suite composes contracts from this object's state, it never calls through
    public override async fetch(): Promise<Response> {
        return new Response("ok");
    }

    /** Deliver alarms so an armed alarm has a handler to wake. */
    // eslint-disable-next-line class-methods-use-this -- the suite asserts arm/read/delete; firing is workerd's business
    public override async alarm(): Promise<void> {
        // Intentionally empty.
    }
}

/**
 * Echoes its own id, so "the same shard key resolves to the same shard" is an
 * observable assertion rather than two identical empty responses.
 */
class TestEchoDO extends DurableObject<Env> {
    public override async fetch(request: Request): Promise<Response> {
        return new Response(`${new URL(request.url).pathname}:${this.ctx.id.toString()}`);
    }
}

/** The real `SchedulerDO`, so the scheduler contract runs against durable state. */
class TestSchedulerDO extends DurableObject<Env> {
    private readonly scheduler: SchedulerDO;

    public constructor(context: DurableObjectState, env: Env) {
        super(context, env);
        this.scheduler = new SchedulerDO(context as never, env as never);
    }

    public override fetch(request: Request): Promise<Response> {
        return this.scheduler.fetch(request);
    }

    public override alarm(): Promise<void> {
        return this.scheduler.alarm();
    }
}

const handler = {
    async fetch(): Promise<Response> {
        return new Response("platform-cloudflare-test-worker", { status: 200 });
    },
};

export default handler;
export { TestEchoDO, TestSchedulerDO, TestShardDO };
export type { Env };
