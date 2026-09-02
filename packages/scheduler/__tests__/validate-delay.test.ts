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
import { describe, expect, it, vi } from "vitest";

import createScheduler from "../src/create-scheduler";
import createWorkpool from "../src/create-workpool";
import { assertScheduleDelay } from "../src/index";
import type { DurableObjectNamespaceLike, DurableObjectStubLike, SchedulableReference } from "../src/types";

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

describe("schedule-delay guard parity", () => {
    it("createScheduler().runAfter rejects through the shared guard", async () => {
        expect.assertions(1);

        const scheduler = createScheduler({ namespace: namespace(), originUrl: "https://app.example" });

        await expect(scheduler.runAfter(-1, target, {})).rejects.toMatchObject({ code: "INVALID_INPUT" });
    });

    it("createWorkpool().enqueue rejects through the shared guard", async () => {
        expect.assertions(1);

        const pool = createWorkpool({ maxConcurrency: 1, namespace: namespace(), originUrl: "https://app.example" });

        await expect(pool.enqueue(target, {}, { delayMs: Number.NaN })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    });
});
