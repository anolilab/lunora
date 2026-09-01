/**
 * Test entry-point Worker for `@lunora/scheduler` integration tests.
 *
 * Boots a real `SchedulerDO` so tests can drive `/schedule`, `/cancel`, and
 * the alarm fire path through the actual workerd alarm scheduler — which the
 * mock-based suite can't model.
 */
import { DurableObject } from "cloudflare:workers";

import type { SchedulerDOState, SchedulerEnv } from "../../src/scheduler-do";
import { SchedulerDO } from "../../src/scheduler-do";
import type { ScheduleRecord } from "../../src/types";

interface Env {
    SCHEDULER: DurableObjectNamespace<TestSchedulerDO>;
}

/**
 * Adapts the real `DurableObjectState` to the `SchedulerDOState` shape the
 * production class is authored against. The Workers runtime's
 * `state.storage.list({ end })` parameter is the EXCLUSIVE upper bound, which is
 * what the unit-suite fake (`../fake-state`) now models as `key < end`. Other
 * methods map 1:1.
 */
const toSchedulerState = (context: DurableObjectState): SchedulerDOState => {
    return {
        storage: {
            delete: (keyOrKeys: string | string[]): Promise<number | boolean> => {
                if (Array.isArray(keyOrKeys)) {
                    return context.storage.delete(keyOrKeys);
                }

                return context.storage.delete(keyOrKeys);
            },
            deleteAlarm: () => context.storage.deleteAlarm(),
            get: <T = unknown>(key: string) => context.storage.get<T>(key),
            getAlarm: () => context.storage.getAlarm(),
            list: <T = unknown>(options: { end?: string; limit?: number; prefix?: string; startAfter?: string } = {}) => context.storage.list<T>(options),
            put: <T = unknown>(entries: Record<string, T> | string, value?: T) => {
                if (typeof entries === "string") {
                    return context.storage.put(entries, value);
                }

                return context.storage.put(entries);
            },
            setAlarm: (time: number | Date) => context.storage.setAlarm(time),
        },
    };
};

class TestSchedulerDO extends DurableObject<Env> {
    /** Records every dispatch attempted by the real alarm fire path. */
    public dispatched: ScheduleRecord[] = [];

    private readonly scheduler: ConcreteScheduler;

    public constructor(context: DurableObjectState, env: Env) {
        super(context, env);
        // Cast: SchedulerEnv is a bag of bindings; our test `Env` is a
        // subtype of it.
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- ConcreteScheduler and TestSchedulerDO are mutually referential; the class is fully defined by the time this constructor runs
        this.scheduler = new ConcreteScheduler(toSchedulerState(context), env as unknown as SchedulerEnv, this);
    }

    public override fetch(request: Request): Promise<Response> {
        return this.scheduler.fetch(request);
    }

    public override alarm(): Promise<void> {
        return this.scheduler.alarm();
    }
}

class ConcreteScheduler extends SchedulerDO {
    public constructor(
        state: SchedulerDOState,
        env: SchedulerEnv,
        private readonly outer: TestSchedulerDO,
    ) {
        super(state, env);
    }

    protected override async dispatch(record: ScheduleRecord): Promise<boolean> {
        this.outer.dispatched.push(record);

        return true;
    }
}

const testWorker = {
    async fetch(_request: Request, _env: Env): Promise<Response> {
        return new Response("test-worker", { status: 200 });
    },
};

export default testWorker;
export { TestSchedulerDO };
export type { Env };
