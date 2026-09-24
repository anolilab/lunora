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

    /**
     * How many dispatches must be in flight at once before `hold()` lets any of
     * them return. `0` disables the barrier (dispatch returns immediately),
     * which is what every test that does not measure concurrency wants.
     */
    public barrier = 0;

    /** Dispatches currently inside `hold()`. */
    public inFlight = 0;

    /** The largest `inFlight` ever observed — the drain's real concurrency. */
    public peakInFlight = 0;

    /**
     * Per dispatched record, the `t:` index rows carrying its id AT THE MOMENT
     * its dispatch was open — the instant an eviction would strike. Sampled from
     * real Durable Object storage, so it proves the claim's durable shape rather
     * than a fake's.
     */
    public indexDuringDispatch: { id: string; keys: string[] }[] = [];

    /** What every dispatch reports back. `false` drives the retry ladder. */
    public dispatchOk = true;

    private readonly scheduler: ConcreteScheduler;

    public constructor(context: DurableObjectState, env: Env) {
        super(context, env);
        // Cast: SchedulerEnv is a bag of bindings; our test `Env` is a
        // subtype of it.
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- ConcreteScheduler and TestSchedulerDO are mutually referential; the class is fully defined by the time this constructor runs
        this.scheduler = new ConcreteScheduler(toSchedulerState(context), env as unknown as SchedulerEnv, this);
    }

    /** Sample the `t:` rows carrying `id`, from inside that record's open dispatch. */
    public async sampleIndex(id: string): Promise<void> {
        const rows = await this.ctx.storage.list<string>({ prefix: "t:" });

        this.indexDuringDispatch.push({ id, keys: [...rows.keys()].filter((key) => key.endsWith(`:${id}`)) });
    }

    /** Arm the `hold()` barrier. A setter, so a test never assigns to the instance directly. */
    public setBarrier(value: number): void {
        this.barrier = value;
    }

    /** Make every dispatch report `ok`, or not. A setter, for the same reason as `setBarrier`. */
    public setDispatchOk(value: boolean): void {
        this.dispatchOk = value;
    }

    /**
     * Park a dispatch until `barrier` of them are in flight together, standing
     * in for the runtime receiver, which answers only once the dispatched
     * function has finished running.
     *
     * The wait yields on a storage READ, not a timer. A Durable Object's timers
     * are gated and delivered in scheduling order, so a `setTimeout` poll keeps
     * handing control back to the SAME waiter and a sibling lane never gets to
     * run — the barrier would then measure the poll, not the drain. A storage
     * read is the yield the runtime actually interleaves.
     *
     * Bounded by a spin count so a drain that CANNOT reach the barrier (a
     * one-at-a-time drain) still finishes and fails on `peakInFlight` rather
     * than hanging the suite until the test timeout.
     */
    public async hold(): Promise<void> {
        this.inFlight += 1;
        this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);

        for (let spin = 0; spin < 50 && this.inFlight < this.barrier; spin += 1) {
            // eslint-disable-next-line no-await-in-loop -- polling for sibling lanes to arrive is inherently sequential
            await this.ctx.storage.get("__barrier_spin");
        }

        this.inFlight -= 1;
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

        await this.outer.sampleIndex(record.id);
        await this.outer.hold();

        return this.outer.dispatchOk;
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
