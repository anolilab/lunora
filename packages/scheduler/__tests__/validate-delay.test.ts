/**
 * The one schedule-delay guard, and the code every surface throws.
 *
 * The guard used to be restated at five call sites throwing three different
 * codes (`INTERNAL` here and in the test harness, `INVALID_INPUT` in
 * `@lunora/server`'s deferred facade, `BAD_REQUEST` in the runtime's REST
 * scheduler client), so a test written against one path caught a code another
 * path never throws. These assertions pin the shared guard AND the code, since
 * the code is the half nothing was checking.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import createScheduler from "../src/create-scheduler";
import createWorkpool from "../src/create-workpool";
import { assertScheduleDelay, assertScheduleInstant } from "../src/index";
import { MAX_SCHEDULED_FOR_MS, SchedulerDO } from "../src/scheduler-do";
import type { DurableObjectNamespaceLike, DurableObjectStubLike, SchedulableReference, ScheduleRecord } from "../src/types";
import { createFakeState } from "./fake-state";

const namespace = (): DurableObjectNamespaceLike => {
    return {
        get: () => {
            return {
                fetch: vi.fn<DurableObjectStubLike["fetch"]>(() => Promise.resolve(Response.json({ id: "id-1", scheduledFor: 1 }))),
            };
        },
        idFromName: (name: string) => name,
    };
};

const target = { __lunoraRef: "mail:send" } as unknown as SchedulableReference<Record<string, unknown>>;

describe("assertScheduleDelay", () => {
    it("accepts a non-negative finite delay", () => {
        expect.assertions(1);

        expect(() => {
            assertScheduleDelay(0, "ctx.scheduler.runAfter");
        }).not.toThrow();
    });

    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("rejects %p as INVALID_INPUT, naming the surface", (delayMs) => {
        expect.assertions(2);

        // `INVALID_INPUT` (400), never `INTERNAL`: `toErrorBody` replaces an
        // internal-coded message with "Internal error", redacting the one
        // sentence that tells the caller which argument to fix.
        expect(() => {
            assertScheduleDelay(delayMs, "ctx.scheduler.runAfter");
        }).toThrow("ctx.scheduler.runAfter: `delayMs` must be a non-negative finite number");

        const thrown = ((): unknown => {
            try {
                assertScheduleDelay(delayMs, "ctx.scheduler.runAfter");
            } catch (error) {
                return error;
            }

            return undefined;
        })();

        expect(thrown).toMatchObject({ code: "INVALID_INPUT" });
    });
});

describe("assertScheduleInstant", () => {
    it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects %p, the value `runAfter` has always refused", (timestampMs) => {
        expect.assertions(1);

        // `runAt` was the door the same bad number walked through: `JSON.stringify`
        // renders it `null`, so the DO stores a `scheduledFor` no alarm can fire and
        // the job is accepted and then never runs.
        expect(() => {
            assertScheduleInstant(timestampMs, 1_000_000, "ctx.scheduler.runAt");
        }).toThrow("ctx.scheduler.runAt: `date` must be a non-negative finite number");
    });

    it("accepts an instant that is already in the past", () => {
        expect.assertions(1);

        // An overdue job is not a bad argument — `runAt(row.dueAt)` on a row that
        // came due mid-request is the ordinary case, and `runAfter` itself reaches
        // `runAt` a fraction of a millisecond after reading its own clock.
        expect(() => {
            assertScheduleInstant(999, 1_000_000, "ctx.scheduler.runAt");
        }).not.toThrow();
    });
});

describe("schedule-delay guard parity", () => {
    it("createScheduler().runAfter rejects through the shared guard", async () => {
        expect.assertions(1);

        const scheduler = createScheduler({ namespace: namespace() });

        await expect(scheduler.runAfter(-1, target, {})).rejects.toMatchObject({ code: "INVALID_INPUT" });
    });

    it("createScheduler().runAt rejects a non-finite instant through the shared guard", async () => {
        expect.assertions(1);

        const scheduler = createScheduler({ namespace: namespace() });

        await expect(scheduler.runAt(Number.NaN, target, {})).rejects.toMatchObject({ code: "INVALID_INPUT" });
    });

    it("createWorkpool().enqueue rejects through the shared guard", async () => {
        expect.assertions(1);

        const pool = createWorkpool({ maxConcurrency: 1, namespace: namespace() });

        await expect(pool.enqueue(target, {}, { delayMs: Number.NaN })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    });

    it("rejects a delay past the latest instant the SchedulerDO can index", () => {
        expect.assertions(2);

        // Refused here, not only by the DO: the deferred facade validates before
        // it hands a mutation its job id, and the DO's refusal would land after
        // the commit.
        expect(() => {
            assertScheduleDelay(MAX_SCHEDULED_FOR_MS, "ctx.scheduler.runAfter");
        }).toThrow("later than the latest schedulable instant");
        expect(() => {
            assertScheduleInstant(MAX_SCHEDULED_FOR_MS + 1, Date.now(), "ctx.scheduler.runAt");
        }).toThrow("ctx.scheduler.runAt: `date` is later than the latest schedulable instant");
    });
});

/**
 * A fractional delay or instant against the REAL SchedulerDO, whose time index
 * takes whole milliseconds only. It used to pass the shared guard (finite,
 * non-negative) and then be refused by the DO with `INVALID_INPUT`.
 */
describe("fractional schedule times", () => {
    class CapturingScheduler extends SchedulerDO {
        public readonly fired: string[] = [];

        protected override async dispatch(record: ScheduleRecord): Promise<boolean> {
            this.fired.push(record.id);

            return true;
        }
    }

    const wire = (): { binding: DurableObjectNamespaceLike; scheduler: CapturingScheduler; state: ReturnType<typeof createFakeState> } => {
        const state = createFakeState();
        const scheduler = new CapturingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        return {
            binding: {
                get: () => {
                    return { fetch: async (input: Request | string, init?: RequestInit) => scheduler.fetch(new Request(input, init)) };
                },
                idFromName: (name: string) => name,
            },
            scheduler,
            state,
        };
    };

    const NOW = 1_800_000_000_000;

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each([
        ["runAfter(1500.5)", (client: ReturnType<typeof createScheduler>) => client.runAfter(1500.5, target, {}), NOW + 1501],
        ["runAfter(1000 / 3)", (client: ReturnType<typeof createScheduler>) => client.runAfter(1000 / 3, target, {}), NOW + 334],
        ["runAt(now + 0.25)", (client: ReturnType<typeof createScheduler>) => client.runAt(NOW + 0.25, target, {}), NOW + 1],
    ])("%s schedules at the next whole millisecond and fires", async (_label, schedule, expected) => {
        expect.assertions(3);

        const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
        const { binding, scheduler } = wire();
        const client = createScheduler({ namespace: binding });

        const id = await schedule(client);

        await expect(client.get(id)).resolves.toMatchObject({ scheduledFor: expected });

        // Not a millisecond early...
        clock.mockReturnValue(expected - 1);
        await scheduler.alarm();

        expect(scheduler.fired).toStrictEqual([]);

        clock.mockReturnValue(expected);
        await scheduler.alarm();

        expect(scheduler.fired).toStrictEqual([id]);
    });

    it("workpool.enqueue accepts a fractional delayMs", async () => {
        expect.assertions(1);

        vi.spyOn(Date, "now").mockReturnValue(NOW);

        const { binding } = wire();
        const pool = createWorkpool({ maxConcurrency: 1, namespace: binding });

        await expect(pool.enqueue(target, {}, { delayMs: 0.5 })).resolves.toMatchObject({ scheduledFor: NOW + 1 });
    });
});
