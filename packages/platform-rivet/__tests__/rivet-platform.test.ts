import { RIVET_CAPABILITIES } from "@lunora/platform";
import { describe, expect, it } from "vitest";

import { createRivetActorDouble } from "../src/conformance/rivet-actor-double";
import { createRivetPlatform } from "../src/rivet-platform";
import { createRivetShardHost, RIVET_ALARM_ACTION } from "../src/rivet-shard-host";
import { openRivetShardState } from "../src/rivet-shard-state";

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

    it("makes pending writes durable through flush and close", async () => {
        expect.assertions(2);

        const actor = createRivetActorDouble();

        try {
            const first = await createRivetPlatform(actor);

            // A bare write outside any boundary. `flush` is what forces it out
            // — the platform exposes that one method rather than the working
            // copy it snapshots.
            first.shard.sql.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)");
            await first.flush();
            await first.close();

            const second = await createRivetPlatform(actor);

            expect(second.shard.sql.exec("SELECT id FROM notes").toArray()).toStrictEqual([]);

            second.shard.sql.exec("INSERT INTO notes (id) VALUES (1)");
            await second.close();

            const third = await createRivetPlatform(actor);

            expect(third.shard.sql.exec("SELECT id FROM notes").toArray()).toStrictEqual([{ id: 1 }]);

            await third.close();
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

    it("arms one schedule when two alarm sets overlap", async () => {
        expect.assertions(2);

        const actor = createRivetActorDouble();

        try {
            const state = await openRivetShardState(actor);

            try {
                const { host } = createRivetShardHost(actor, state);

                // Both calls are in flight before either finishes arming. A
                // `set` that sampled the alarm it replaces *before* its own
                // await would see the same predecessor twice, leave one of the
                // two schedules armed, and fire a spurious `deliverAlarm()` for
                // an alarm the engine believes it replaced.
                await Promise.all([host.alarms.set(Date.now() + 60_000), host.alarms.set(Date.now() + 90_000)]);

                const armed = await actor.schedule.list();
                // `ShardAlarms.get` may be sync or async per the contract; this
                // host answers from an in-memory mirror, so it is sync here.
                const pending = await host.alarms.get();

                expect(armed).toHaveLength(1);
                expect(pending).toBe(armed[0]?.runAt);
            } finally {
                state.close();
            }
        } finally {
            actor.cleanup();
        }
    });

    it("retires every stale alarm schedule on a wake", async () => {
        expect.assertions(2);

        const actor = createRivetActorDouble();

        try {
            const earliest = Date.now() + 60_000;

            // Two alarm schedules pending at once — `ShardAlarms` is a single
            // slot, so the later one is by definition an alarm nothing believes
            // in any more. A restore that re-armed the earliest and ignored the
            // rest would leave it armed across this wake and every one after.
            await actor.schedule.at(earliest, RIVET_ALARM_ACTION);
            await actor.schedule.at(Date.now() + 90_000, RIVET_ALARM_ACTION);

            const platform = await createRivetPlatform(actor);
            const pending = await platform.shard.alarms.get();

            expect(pending).toBe(earliest);
            await expect(actor.schedule.list()).resolves.toHaveLength(1);

            await platform.close();
        } finally {
            actor.cleanup();
        }
    });
});
