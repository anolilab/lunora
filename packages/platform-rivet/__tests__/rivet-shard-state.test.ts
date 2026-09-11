import { describe, expect, it } from "vitest";

import { createRivetActorDouble } from "../src/conformance/rivet-actor-double";
import { createRivetShardHost } from "../src/rivet-shard-host";
import { clearRivetShardSnapshot, openRivetShardState } from "../src/rivet-shard-state";

/**
 * The async/sync bridge is the reason this package exists, so these are the
 * legs the shared TCK cannot reach: it drives one host over one working copy
 * and never sleeps the actor. What is asserted here is the half that only shows
 * up across a wake — that a committed write is in the snapshot, and that an
 * uncommitted one is not.
 */
describe("rivet shard state", () => {
    it("stays dirty when a write lands while the snapshot is being persisted", async () => {
        expect.assertions(2);

        const actor = createRivetActorDouble();

        try {
            /** Armed for exactly one `execute`, so only the snapshot write is held. */
            let gate: Promise<void> | undefined;

            // The actor double resolves `execute` synchronously, and flushes now
            // take a queue slot before they serialize — so a mark made in the
            // same tick as `flush()` lands BEFORE the bytes are captured and is
            // legitimately part of them. Holding the durable write open is what
            // puts the second mark where this test needs it: after the copy was
            // serialized, before it reached Rivet's SQLite.
            const state = await openRivetShardState({
                db: {
                    execute: async <Row extends Record<string, unknown> = Record<string, unknown>>(query: string, ...args: unknown[]): Promise<Row[]> => {
                        if (gate !== undefined) {
                            const held = gate;

                            gate = undefined;

                            await held;
                        }

                        return await actor.db.execute<Row>(query, ...args);
                    },
                },
            });

            state.database.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
            state.markDirty();

            let release: () => void = () => {};

            gate = new Promise<void>((resolve) => {
                release = resolve;
            });

            const flushing = state.flush();

            // A macrotask, so every microtask has drained: the flush has taken
            // its slot, serialized the copy, and is parked on the gated write.
            await new Promise((resolve) => {
                setTimeout(resolve, 0);
            });

            // A second write inside the flush's await window — the shape a socket
            // callback takes while its own snapshot is being written. Before the
            // fix the flag was cleared for this write too, even though the
            // serialized copy predates it, and the next wake lost it silently.
            state.markDirty();

            release();

            await flushing;

            // Still owed: the second mark is not in what was just persisted.
            expect(state.isDirty).toBe(true);

            await state.flush();

            expect(state.isDirty).toBe(false);
        } finally {
            await clearRivetShardSnapshot(actor.db);
        }
    });

    it("restores a committed write into a second wake's working copy", async () => {
        expect.assertions(2);

        const actor = createRivetActorDouble();

        try {
            const first = await openRivetShardState(actor);
            const { host } = createRivetShardHost(actor, first);

            await host.transaction(async () => {
                host.sql.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
                host.sql.exec("INSERT INTO notes (id, body) VALUES (1, 'survives')");
            });

            expect(first.isDirty).toBe(false);

            // The actor sleeps: the working copy is gone, Rivet's SQLite is not.
            first.close();

            const second = await openRivetShardState(actor);
            const { host: woken } = createRivetShardHost(actor, second);

            expect(woken.sql.exec<{ body: string }>("SELECT body FROM notes WHERE id = 1").one().body).toBe("survives");

            second.close();
        } finally {
            actor.cleanup();
        }
    });

    it("leaves a rolled-back write out of the snapshot", async () => {
        expect.assertions(1);

        const actor = createRivetActorDouble();

        try {
            const state = await openRivetShardState(actor);
            const { host } = createRivetShardHost(actor, state);

            await host.transaction(async () => {
                host.sql.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)");
            });

            await expect(
                host.transaction(async () => {
                    host.sql.exec("INSERT INTO notes (id) VALUES (2)");
                    throw new Error("boom");
                }),
            ).rejects.toThrow("boom");

            state.close();
        } finally {
            actor.cleanup();
        }
    });

    it("does not restore a rolled-back write on the next wake", async () => {
        expect.assertions(1);

        const actor = createRivetActorDouble();

        try {
            const first = await openRivetShardState(actor);
            const { host } = createRivetShardHost(actor, first);

            await host.transaction(async () => {
                host.sql.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)");
            });
            await host
                .transaction(async () => {
                    host.sql.exec("INSERT INTO notes (id) VALUES (2)");
                    throw new Error("boom");
                })
                .catch(() => undefined);

            first.close();

            const second = await openRivetShardState(actor);

            expect(second.database.prepare("SELECT id FROM notes").all()).toStrictEqual([]);

            second.close();
        } finally {
            actor.cleanup();
        }
    });

    it("treats a read as clean and a write as dirty", async () => {
        expect.assertions(3);

        const actor = createRivetActorDouble();

        try {
            const state = await openRivetShardState(actor);
            const { host } = createRivetShardHost(actor, state);

            host.sql.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)");

            expect(state.isDirty).toBe(true);

            await state.flush();

            expect(state.isDirty).toBe(false);

            // A read must not dirty the shard: if it did, every query would
            // re-serialize the whole database at the next boundary.
            host.sql.exec("SELECT id FROM notes").toArray();

            expect(state.isDirty).toBe(false);

            state.close();
        } finally {
            actor.cleanup();
        }
    });

    it("marks a RETURNING write dirty even though it produces rows", async () => {
        expect.assertions(1);

        const actor = createRivetActorDouble();

        try {
            const state = await openRivetShardState(actor);
            const { host } = createRivetShardHost(actor, state);

            host.sql.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)");
            await state.flush();

            // `INSERT … RETURNING` is a writer that a "does the text start with
            // SELECT" heuristic would classify as a read — and a write left out
            // of the snapshot is a write that vanishes on sleep. better-sqlite3
            // reports it as a reader too, so this is the leg that pins the
            // dirty flag being set from the statement's effect rather than from
            // its shape.
            host.sql.exec("INSERT INTO notes (id) VALUES (7) RETURNING id").toArray();

            expect(state.isDirty).toBe(true);

            state.close();
        } finally {
            actor.cleanup();
        }
    });

    it("opens a first-wake working copy after the snapshot is cleared", async () => {
        expect.assertions(1);

        const actor = createRivetActorDouble();

        try {
            const first = await openRivetShardState(actor);
            const { host } = createRivetShardHost(actor, first);

            await host.transaction(async () => {
                host.sql.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)");
            });
            first.close();

            await clearRivetShardSnapshot(actor.db);

            const second = await openRivetShardState(actor);

            expect(() => second.database.prepare("SELECT id FROM notes").all()).toThrow(/no such table/u);

            second.close();
        } finally {
            actor.cleanup();
        }
    });

    it("keeps the shard's uncommitted rows out of a snapshot", async () => {
        expect.assertions(2);

        const actor = createRivetActorDouble();

        try {
            const first = await openRivetShardState(actor);
            const { host } = createRivetShardHost(actor, first);

            await host.transaction(async () => {
                host.sql.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)");
                host.sql.exec("INSERT INTO notes (id) VALUES (1)");
            });

            // `serialize()` reads the working copy as it stands, open
            // transaction included — so a flush racing a transaction (a
            // `close()` on the sleep path, say) would make the uncommitted row
            // durable and, because the dirty flag is cleared on success, never
            // re-snapshot the state that actually survived the rollback.
            await host
                .transaction(async () => {
                    host.sql.exec("INSERT INTO notes (id) VALUES (2)");
                    await first.flush();

                    throw new Error("mutation failed");
                })
                .catch(() => undefined);

            expect(first.isDirty).toBe(true);

            first.close();

            const second = await openRivetShardState(actor);
            const { host: woken } = createRivetShardHost(actor, second);

            expect(woken.sql.exec("SELECT id FROM notes ORDER BY id").toArray()).toStrictEqual([{ id: 1 }]);

            second.close();
        } finally {
            actor.cleanup();
        }
    });
});
