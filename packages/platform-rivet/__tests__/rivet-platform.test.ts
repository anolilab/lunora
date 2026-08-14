import { RIVET_CAPABILITIES } from "@lunora/platform";
import { describe, expect, it } from "vitest";

import { createRivetActorDouble } from "../src/conformance/rivet-actor-double";
import { createRivetPlatform } from "../src/rivet-platform";
import { RIVET_ALARM_ACTION } from "../src/rivet-shard-host";

describe("rivet platform", () => {
    it("re-attaches a pending alarm across a wake", async () => {
        expect.assertions(3);

        const actor = createRivetActorDouble();

        try {
            const target = Date.now() + 60_000;
            const first = await createRivetPlatform(actor);

            await first.shard.alarms.set(target);
            actor.actions.set(RIVET_ALARM_ACTION, async () => first.deliverAlarm());

            // `ShardAlarms.get` may be sync or async per the contract; this host
            // answers from an in-memory mirror, so it is sync here.
            const armed = await first.shard.alarms.get();

            expect(armed).toBe(target);

            await first.close();

            // The actor sleeps. Rivet keeps the schedule; this host's in-memory
            // mirror of it does not survive, so without the restore pass the
            // woken platform would report no pending alarm — and the next
            // `set()` would leak the schedule it never knew about.
            const second = await createRivetPlatform(actor);

            const restored = await second.shard.alarms.get();

            expect(restored).toBe(target);
            // Exactly one schedule armed, not two: the restore re-arms through
            // the contract and retires the entry it replaced.
            await expect(actor.schedule.list()).resolves.toHaveLength(1);

            await second.close();
        } finally {
            actor.cleanup();
        }
    });

    it("flushes pending writes on close", async () => {
        expect.assertions(2);

        const actor = createRivetActorDouble();

        try {
            const first = await createRivetPlatform(actor);

            // A bare write outside any boundary: dirty, and not yet durable.
            first.shard.sql.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)");

            expect(first.state.isDirty).toBe(true);

            await first.close();

            const second = await createRivetPlatform(actor);

            expect(second.shard.sql.exec("SELECT id FROM notes").toArray()).toStrictEqual([]);

            await second.close();
        } finally {
            actor.cleanup();
        }
    });

    it("reports the Rivet capability matrix", async () => {
        expect.assertions(2);

        const actor = createRivetActorDouble();

        try {
            const platform = await createRivetPlatform(actor);

            expect(platform.capabilities).toBe(RIVET_CAPABILITIES);
            expect(platform.capabilities.id).toBe("rivet");

            await platform.close();
        } finally {
            actor.cleanup();
        }
    });

    it("holds the actor awake for background work handed to waitUntil", async () => {
        expect.assertions(3);

        const actor = createRivetActorDouble();

        try {
            const platform = await createRivetPlatform(actor);

            // `waitUntil` is optional on the contract — hosts with no
            // request/background distinction omit it. This one has Rivet's own
            // sleep grace period to extend against, so it must be present.
            expect(platform.shard.waitUntil).toBeDefined();

            let done = false;
            platform.shard.waitUntil?.(
                new Promise<void>((resolve) => {
                    setTimeout(() => {
                        done = true;
                        resolve();
                    }, 10);
                }),
            );

            // Rivet's own `waitUntil` got the work too, so the actor will not
            // sleep mid-flight — the half a Node process cannot offer at all.
            await actor.settle();

            expect(done).toBe(true);

            await platform.drain();

            expect(done).toBe(true);

            await platform.close();
        } finally {
            actor.cleanup();
        }
    });
});
