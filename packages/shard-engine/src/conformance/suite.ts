/**
 * The engine contract suite — what `@lunora/shard-engine` guarantees when it
 * runs on a conforming host.
 *
 * # Why this is separate from `@lunora/platform/conformance`
 *
 * That suite asserts what a HOST must provide: serialized execution, a
 * transaction boundary, a SQL cursor, hibernatable sockets. This one asserts
 * what the ENGINE does with those primitives — OCC, RLS, reactive fan-out. The
 * split is forced rather than chosen: the engine-level assertions need
 * `createShardCtxDb`, which lives here, and `@lunora/platform` is zero-dependency
 * by contract. Importing this package from there would invert the dependency and
 * cycle.
 *
 * So plan 114 §5.4's list is encoded across two suites, and a host is only
 * proven when it passes both — the host contract, then the engine behaviours
 * layered on it.
 *
 * # What a host has to hand over
 *
 * Only a {@link ShardHost}. Everything else is built here, which is the point:
 * if the engine's guarantees can be reproduced from the contract alone, the
 * contract is sufficient. Anything that turns out to need a provider API is a
 * porting blocker, and this suite is where it surfaces.
 *
 * ```ts
 * import { describe, expect, it } from "vitest";
 * import { defineEngineContractSuite } from "@lunora/shard-engine/conformance";
 *
 * defineEngineContractSuite("my-host", createMyShardHost, { describe, expect, it });
 * ```
 */
import type { ShardHost } from "@lunora/platform";

import type { SchemaLike, ValidatorLike } from "../schema-types";
import type { SqlExec } from "../ctx-db";
import { createShardCtxDb, runShardMigrations } from "../ctx-db";
import { ConflictError } from "../transaction";

/** Vitest's globals, injected so a host can wrap each body (e.g. `runInDurableObject`). */
export interface EngineVitestApi {
    describe: (name: string, body: () => void) => void;
    expect: (actual: unknown) => {
        rejects: { toBeInstanceOf: (ctor: unknown) => Promise<void>; toThrow: (matcher?: unknown) => Promise<void> };
        toBe: (expected: unknown) => void;
        toBeUndefined: () => void;
        toStrictEqual: (expected: unknown) => void;
    };
    it: (name: string, body: () => Promise<void> | void) => void;
}

/** Builds a fresh {@link ShardHost} per test. Must be isolated — tables persist otherwise. */
export type EngineHostFactory = () => { close?: () => void; host: ShardHost };

const column = (kind: string, meta: Record<string, unknown> = {}): ValidatorLike =>
    ({ _meta: { column: { notNull: true, ...meta } }, kind }) as unknown as ValidatorLike;

/**
 * Register the engine contract suite for one host.
 * @param name Host label, shown in the test tree.
 * @param factory Builds an isolated host per test.
 * @param vitest Injected `describe`/`expect`/`it`.
 */
export const defineEngineContractSuite = (name: string, factory: EngineHostFactory, vitest: EngineVitestApi): void => {
    const { describe, expect, it } = vitest;

    describe(`engine contract: ${name}`, () => {
        describe("optimistic concurrency", () => {
            /**
             * The OCC guard is a compare-and-swap: every write carries the row's
             * read-time `__doc__` in its `WHERE`, and a write that touches zero
             * rows means someone else committed during the intervening `await`.
             *
             * The clobber is issued as RAW SQL from inside a before-update
             * trigger, which is the only way to reproduce the race honestly.
             * Going through `ctx.db` instead re-enters the trigger and trips the
             * recursion guard first — a DIFFERENT conflict (`kind: "trigger"`),
             * asserted separately below. Raw SQL mutates `__doc__` without
             * firing triggers, so the in-flight update's snapshot goes stale
             * exactly as a concurrent writer would make it.
             */
            const conflictingSchema = (sql: SqlExec): SchemaLike =>
                ({
                    tables: {
                        items: {
                            indexes: [],
                            shape: { title: column("string"), version: column("number", { notNull: false }) },
                            triggerMap: {
                                clobber: {
                                    handler: () => {
                                        sql.exec(`UPDATE "items" SET "__doc__" = json_set("__doc__", '$.version', 99) WHERE "id" = 'i1'`);
                                    },
                                    op: "update",
                                    timing: "before",
                                },
                            },
                        },
                    },
                }) as unknown as SchemaLike;

            it("raises a CONFLICT of kind `occ` when a write's snapshot is clobbered", async () => {
                const { close, host } = factory();

                try {
                    const sql = host.sql as unknown as SqlExec;
                    const schema = conflictingSchema(sql);

                    runShardMigrations(sql, schema);

                    const db = createShardCtxDb({ schema, sql });

                    await db.insert("items", { _id: "i1", title: "first", version: 1 }, { allowExplicitId: true });

                    // The trigger patches the row mid-flight, so this update's CAS
                    // matches nothing. A host whose SQL cannot report `changes()`
                    // silently loses the whole guarantee, which is why it is here.
                    await expect(db.patch("i1", { title: "second" })).rejects.toBeInstanceOf(ConflictError);
                } finally {
                    close?.();
                }
            });

            it("reports the conflict as CONFLICT/409 rather than retrying it away", async () => {
                const { close, host } = factory();

                try {
                    const sql = host.sql as unknown as SqlExec;
                    const schema = conflictingSchema(sql);

                    runShardMigrations(sql, schema);

                    const db = createShardCtxDb({ schema, sql });

                    await db.insert("items", { _id: "i1", title: "first", version: 1 }, { allowExplicitId: true });

                    let raised: unknown;

                    try {
                        await db.patch("i1", { title: "second" });
                    } catch (error) {
                        raised = error;
                    }

                    const conflict = raised as ConflictError & { code: string; status?: number };

                    // Deliberately NOT retried server-side: the client refetches and
                    // decides. A host that wrapped writes in a retry loop would turn
                    // a visible 409 into silent lost-update, so the absence of a
                    // retry is itself the contract.
                    expect(conflict.code).toBe("CONFLICT");
                    expect(conflict.kind).toBe("occ");
                } finally {
                    close?.();
                }
            });

            it("leaves the row readable and unchanged after a conflict", async () => {
                const { close, host } = factory();

                try {
                    const sql = host.sql as unknown as SqlExec;
                    const schema = conflictingSchema(sql);

                    runShardMigrations(sql, schema);

                    const db = createShardCtxDb({ schema, sql });

                    await db.insert("items", { _id: "i1", title: "first", version: 1 }, { allowExplicitId: true });

                    try {
                        await db.patch("i1", { title: "second" });
                    } catch {
                        // expected — asserted above
                    }

                    // A conflict must not leave a half-applied write behind: the
                    // caller is told to refetch, and what it refetches has to be
                    // coherent. Both fields are asserted because "coherent" here
                    // means a specific pair — the winning write landed in full
                    // (`version`) and the losing one landed not at all (`title`).
                    // Checking only `title` would pass on a host that dropped
                    // both writes.
                    const doc = (await db.get("i1")) as Record<string, unknown> | undefined;

                    expect(doc?.["title"]).toBe("first");
                    expect(doc?.["version"]).toBe(99);
                } finally {
                    close?.();
                }
            });

            /**
             * The neighbouring guarantee, and the reason the legs above go
             * through raw SQL.
             *
             * A trigger that writes its own row *through `ctx.db`* re-enters the
             * trigger, and without a depth ceiling that recurses until the host
             * runs out of stack — a host-specific crash instead of an error the
             * caller can act on. The ceiling turns it into the same
             * `CONFLICT`, distinguished only by `kind`. Both kinds are pinned
             * because a host that collapsed them would report a schema bug as a
             * concurrency race, and the client's response to those differs:
             * refetch-and-retry is right for one and an infinite loop for the
             * other.
             */
            it("raises a CONFLICT of kind `trigger` when a trigger writes its own row through the db", async () => {
                const { close, host } = factory();

                try {
                    const sql = host.sql as unknown as SqlExec;
                    const schema = {
                        tables: {
                            items: {
                                indexes: [],
                                shape: { title: column("string"), version: column("number", { notNull: false }) },
                                triggerMap: {
                                    recurse: {
                                        handler: async (
                                            context: { db: { patch: (id: string, patch: Record<string, unknown>) => Promise<unknown> } },
                                            event: { doc: Record<string, unknown> },
                                        ) => {
                                            await context.db.patch(event.doc["_id"] as string, { version: 99 });
                                        },
                                        op: "update",
                                        timing: "before",
                                    },
                                },
                            },
                        },
                    } as unknown as SchemaLike;

                    runShardMigrations(sql, schema);

                    const db = createShardCtxDb({ schema, sql });

                    await db.insert("items", { _id: "i1", title: "first", version: 1 }, { allowExplicitId: true });

                    let raised: unknown;

                    try {
                        await db.patch("i1", { title: "second" });
                    } catch (error) {
                        raised = error;
                    }

                    const conflict = raised as ConflictError & { code: string };

                    expect(conflict).toBeInstanceOf(ConflictError);
                    expect(conflict.code).toBe("CONFLICT");
                    expect(conflict.kind).toBe("trigger");
                } finally {
                    close?.();
                }
            });
        });
    });
};
