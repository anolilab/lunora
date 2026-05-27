/**
 * Test entry-point Worker for `@cirrus/scheduler` integration tests.
 *
 * Boots a real `SchedulerDO` so tests can drive `/schedule`, `/cancel`, and
 * the alarm fire path through the actual workerd alarm scheduler — which the
 * mock-based suite can't model.
 */
import { DurableObject } from "cloudflare:workers";

import { SchedulerDO } from "../../src/SchedulerDO.js";
import type { SchedulerDOState, SchedulerEnv } from "../../src/SchedulerDO.js";
import type { ScheduleRecord } from "../../src/types.js";

export interface Env {
    SCHEDULER: DurableObjectNamespace<TestSchedulerDO>;
}

/**
 * Adapts the real `DurableObjectState` to the `SchedulerDOState` shape the
 * production class is authored against. The Workers runtime's
 * `state.storage.list({ end })` parameter is the inclusive upper bound; the
 * mock honours `key < end` which is the same semantics. Other methods map 1:1.
 */
const toSchedulerState = (ctx: DurableObjectState): SchedulerDOState => ({
    storage: {
        get: <T = unknown>(key: string) => ctx.storage.get<T>(key) as Promise<T | undefined>,
        put: <T = unknown>(entries: Record<string, T> | string, value?: T) => {
            if (typeof entries === "string") {
                return ctx.storage.put(entries, value);
            }

            return ctx.storage.put(entries);
        },
        delete: (keyOrKeys: string | string[]) => {
            if (Array.isArray(keyOrKeys)) {
                return ctx.storage.delete(keyOrKeys);
            }

            return ctx.storage.delete(keyOrKeys);
        },
        list: <T = unknown>(options: { prefix?: string; limit?: number; end?: string } = {}) =>
            ctx.storage.list<T>(options),
        setAlarm: (time: number | Date) => ctx.storage.setAlarm(time),
        getAlarm: () => ctx.storage.getAlarm(),
        deleteAlarm: () => ctx.storage.deleteAlarm(),
    },
});

export class TestSchedulerDO extends DurableObject<Env> {
    private readonly scheduler: ConcreteScheduler;

    /** Records every dispatch attempted by the real alarm fire path. */
    public dispatched: ScheduleRecord[] = [];

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        // Cast: SchedulerEnv is a bag of bindings; our test `Env` is a
        // subtype of it.
        this.scheduler = new ConcreteScheduler(toSchedulerState(ctx), env as unknown as SchedulerEnv, this);
    }

    public override fetch(request: Request): Promise<Response> {
        return this.scheduler.fetch(request);
    }

    public override alarm(): Promise<void> {
        return this.scheduler.alarm();
    }
}

class ConcreteScheduler extends SchedulerDO {
    constructor(state: SchedulerDOState, env: SchedulerEnv, private readonly outer: TestSchedulerDO) {
        super(state, env);
    }

    protected override async dispatch(record: ScheduleRecord): Promise<boolean> {
        this.outer.dispatched.push(record);

        return true;
    }
}

export default {
    async fetch(_request: Request, _env: Env): Promise<Response> {
        return new Response("test-worker", { status: 200 });
    },
};
