import type { QueryArgs, QueryPage } from "@lunora/shard-engine";
import { RELATION_EXISTS_KEY, resolveRelationPredicates } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike, SqlExec } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Relation-crossing `where` predicates (Prisma-style `is`/`isNot`/`some`/
 * `none`/`every`) against a real SQLite engine — workerd can't run in the
 * sandbox, and the pre-resolver is dialect-agnostic, so proving it here proves
 * the same path D1 takes. The resolver rewrites each relation node into a flat
 * `IN`/`NOT IN` via a batched child fetch, so these assertions also pin the
 * empty-set and NULL-FK edge cases the rewrite depends on.
 */

let harness: ReturnType<typeof createSqliteExec>;

const schema: SchemaLike = {
    tables: {
        messages: {
            indexes: [{ fields: ["authorId"], name: "by_author" }],
            relationMap: {
                author: { field: "authorId", kind: "one", references: "_id", table: "users" },
                reactions: { field: "messageId", kind: "many", references: "_id", table: "reactions" },
            },
            shape: { authorId: { kind: "string" }, body: { kind: "string" } },
        },
        reactions: {
            indexes: [{ fields: ["messageId"], name: "by_message" }],
            relationMap: {
                message: { field: "messageId", kind: "one", references: "_id", table: "messages" },
            },
            shape: { emoji: { kind: "string" }, messageId: { kind: "string" } },
        },
        users: {
            indexes: [],
            relationMap: {
                messages: { field: "authorId", kind: "many", references: "_id", table: "messages" },
            },
            shape: { name: { kind: "string" } },
        },
    },
};

const makeWriter = (): DatabaseWriterLike => {
    runShardMigrations(harness.sql, schema);

    return createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
};

// Production default is `"auto"` (semijoin-first), which on these small fixtures
// never escalates to EXISTS — so the Phase 2 push-down tests force `"always"` to
// exercise the correlated-EXISTS compile path directly.
const makePushWriter = (): DatabaseWriterLike => {
    runShardMigrations(harness.sql, schema);

    return createShardContextDatabase({ clock: () => 1_700_000_000_000, relationExistsPushDown: "always", schema, sql: harness.sql });
};

const ids = (docs: Record<string, unknown>[]): unknown[] => docs.map((document_) => document_["_id"]).toSorted((a, b) => String(a).localeCompare(String(b)));

/*
 * Seed:
 * - users: u1 Ada, u2 Linus, u3 Loner (no messages)
 * - messages: m1 "hi" (u1), m2 "yo" (u1), m3 "hey" (u2), mNull (authorId null), mGhost (authorId "ghost" — dangling)
 * - reactions: r1,r2 on m1, r3 on m2, r4 on m3
 */
const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    await writer.insert("users", { _id: "u1", name: "Ada" }, { allowExplicitId: true });
    await writer.insert("users", { _id: "u2", name: "Linus" }, { allowExplicitId: true });
    await writer.insert("users", { _id: "u3", name: "Loner" }, { allowExplicitId: true });
    await writer.insert("messages", { _id: "m1", authorId: "u1", body: "hi" }, { allowExplicitId: true });
    await writer.insert("messages", { _id: "m2", authorId: "u1", body: "yo" }, { allowExplicitId: true });
    await writer.insert("messages", { _id: "m3", authorId: "u2", body: "hey" }, { allowExplicitId: true });

    await writer.insert("messages", { _id: "mNull", authorId: null, body: "void" }, { allowExplicitId: true });
    await writer.insert("messages", { _id: "mGhost", authorId: "ghost", body: "dangling" }, { allowExplicitId: true });
    await writer.insert("reactions", { _id: "r1", emoji: "👍", messageId: "m1" }, { allowExplicitId: true });
    await writer.insert("reactions", { _id: "r2", emoji: "🎉", messageId: "m1" }, { allowExplicitId: true });
    await writer.insert("reactions", { _id: "r3", emoji: "🔥", messageId: "m2" }, { allowExplicitId: true });
    await writer.insert("reactions", { _id: "r4", emoji: "💀", messageId: "m3" }, { allowExplicitId: true });
};

describe("ctx-db relation predicates", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    describe("to-one is / isNot", () => {
        it("is — parent matches when its FK points at a child matching W", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            const { page } = await writer.findMany("messages", { where: { author: { is: { name: "Ada" } } } });

            // m1, m2 (authored by Ada); mNull/mGhost/m3 excluded.
            expect(ids(page)).toEqual(["m1", "m2"]);
        });

        it("is — empty child match yields no rows (IN [] → 0 = 1)", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            const { page } = await writer.findMany("messages", { where: { author: { is: { name: "Nobody" } } } });

            expect(page).toHaveLength(0);
        });

        it("is — a null FK never matches a non-empty IN", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            const { page } = await writer.findMany("messages", { where: { author: { is: { name: "Linus" } } } });

            // Only m3; mNull (null FK) is excluded even though it has no author.
            expect(ids(page)).toEqual(["m3"]);
        });

        it("isNot — matches non-matching rows PLUS rows with an absent/dangling FK", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            const { page } = await writer.findMany("messages", { where: { author: { isNot: { name: "Ada" } } } });

            // m3 (Linus) + mNull (null FK) + mGhost (dangling FK) — m1/m2 (Ada) excluded.
            expect(ids(page)).toEqual(["m3", "mGhost", "mNull"]);
        });

        it("isNot — empty negated set matches everything (NOT IN [] → 1 = 1)", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            const { page } = await writer.findMany("messages", { where: { author: { isNot: { name: "Nobody" } } } });

            expect(ids(page)).toEqual(["m1", "m2", "m3", "mGhost", "mNull"]);
        });
    });

    describe("to-many some / none / every", () => {
        it("some — parent matches when at least one child matches W", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            const { page } = await writer.findMany("users", { where: { messages: { some: { body: "hey" } } } });

            expect(ids(page)).toEqual(["u2"]);
        });

        it("some — empty child match yields no parents", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            const { page } = await writer.findMany("users", { where: { messages: { some: { body: "zzz" } } } });

            expect(page).toHaveLength(0);
        });

        it("none — parents with no matching child, including childless parents", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            const { page } = await writer.findMany("users", { where: { messages: { none: { body: "hey" } } } });

            // Ada (hi/yo, no hey) + Loner (no messages); Linus excluded.
            expect(ids(page)).toEqual(["u1", "u3"]);
        });

        it("every — all readable children match W; childless parents are vacuously included", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            const { page } = await writer.findMany("users", { where: { messages: { every: { body: { contains: "h" } } } } });

            // Linus (only "hey", has h) + Loner (no messages, vacuous); Ada excluded ("yo" lacks h).
            expect(ids(page)).toEqual(["u2", "u3"]);
        });
    });

    describe("composition", () => {
        it("aND — relation predicate combined with a flat column predicate", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            const { page } = await writer.findMany("messages", { where: { AND: [{ author: { is: { name: "Ada" } } }, { body: "hi" }] } });

            expect(ids(page)).toEqual(["m1"]);
        });

        it("oR — two relation predicates", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            const { page } = await writer.findMany("users", {
                where: { OR: [{ messages: { some: { body: "hey" } } }, { messages: { some: { body: "hi" } } }] },
            });

            // Linus (hey) + Ada (hi).
            expect(ids(page)).toEqual(["u1", "u2"]);
        });

        it("nOT { some } is equivalent to none", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            const { page } = await writer.findMany("users", { where: { NOT: { messages: { some: { body: "hey" } } } } });

            expect(ids(page)).toEqual(["u1", "u3"]);
        });

        it("multi-hop — reactions whose message's author is Ada", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            const { page } = await writer.findMany("reactions", { where: { message: { is: { author: { is: { name: "Ada" } } } } } });

            // r1, r2 (on m1) + r3 (on m2) — both m1 and m2 authored by Ada; r4 (on m3, Linus) excluded.
            expect(ids(page)).toEqual(["r1", "r2", "r3"]);
        });
    });

    describe("rLS interaction", () => {
        it("relationBaseWhere filters the child fetch, so a hidden child can't satisfy `some`", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            // The child read policy hides every message except body "hi". The
            // `some: { body: "hey" }` child fetch runs under that policy, so m3
            // ("hey", by Linus) is invisible and no user matches.
            const { page } = await writer.findMany("users", {
                relationBaseWhere: (table) => (table === "messages" ? { body: "hi" } : undefined),
                where: { messages: { some: { body: "hey" } } },
            });

            expect(page).toHaveLength(0);
        });
    });

    describe("guards", () => {
        it("throws on a cardinality mismatch (some on a to-one relation)", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            await expect(writer.findMany("messages", { where: { author: { some: { name: "Ada" } } } })).rejects.toThrow(/requires a to-many relation/u);
        });

        it("throws on a cardinality mismatch (is on a to-many relation)", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            await expect(writer.findMany("users", { where: { messages: { is: { body: "hi" } } } })).rejects.toThrow(/requires a to-one relation/u);
        });

        it("rankPage() rejects a relation predicate instead of silently dropping it", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            // rankPage's `where` only pins the partition — it never compiles into
            // a row filter — so a relation predicate would silently fail open.
            // The guard sits before the rankIndex lookup, so it fires here even
            // though the fixture declares no rankIndex.
            await expect(writer.rankPage("messages", "by_author", { where: { author: { is: { name: "Ada" } } } })).rejects.toThrow(
                /not supported in rankPage/u,
            );
        });
    });

    describe("aggregate / count / groupBy resolve relation predicates", () => {
        it("count() resolves a to-many `some` to a semijoin", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            // u1 (Ada) and u2 (Linus) authored messages; u3 (Loner) didn't.
            // `some: {}` matches every user with at least one message.
            await expect(writer.count("users", { messages: { some: {} } })).resolves.toBe(2);
        });

        it("aggregate() resolves a relation predicate (max over the semijoined set)", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            // Only Ada's messages ("hi", "yo"), scoped via the to-one
            // `author.is` semijoin; MAX over the two bodies is "yo". (`aggregate`
            // is typed `number | null`; this field is text, so normalize for the
            // comparison.)
            const max = await writer.aggregate("messages", { field: "body", op: "max", where: { author: { is: { name: "Ada" } } } });

            expect(String(max)).toBe("yo");
        });

        it("groupBy() resolves a relation predicate before grouping", async () => {
            expect.assertions(1);

            const writer = makeWriter();

            await seed(writer);

            // Group messages authored by Ada by their authorId — one group.
            const groups = await writer.groupBy("messages", { by: ["authorId"], where: { author: { is: { name: "Ada" } } } });

            expect(groups).toStrictEqual([{ key: { authorId: "u1" }, value: 2 }]);
        });
    });

    describe("phase 2 — correlated EXISTS push-down", () => {
        // A representative slice of every operator + nesting shape, run through
        // both the push-down and the semijoin path on the same fixtures.
        const cases: { args: QueryArgs; table: string }[] = [
            { args: { where: { author: { is: { name: "Ada" } } } }, table: "messages" },
            { args: { where: { author: { isNot: { name: "Ada" } } } }, table: "messages" },
            { args: { where: { messages: { some: { body: "hey" } } } }, table: "users" },
            { args: { where: { messages: { none: { body: "hey" } } } }, table: "users" },
            { args: { where: { messages: { every: { body: { contains: "h" } } } } }, table: "users" },
            { args: { where: { AND: [{ author: { is: { name: "Ada" } } }, { body: "hi" }] } }, table: "messages" },
            { args: { where: { OR: [{ messages: { some: { body: "hey" } } }, { messages: { some: { body: "hi" } } }] } }, table: "users" },
            { args: { where: { message: { is: { author: { is: { name: "Ada" } } } } } }, table: "reactions" },
        ];

        it("returns identical rows to the semijoin path on the same fixtures", async () => {
            expect.assertions(8);

            const pushed = makePushWriter();

            await seed(pushed);

            // A second writer over the *same* migrated+seeded SQLite, forced onto
            // the semijoin — so any divergence is the EXISTS rewrite, not the data.
            const semijoin = createShardContextDatabase({ clock: () => 1_700_000_000_000, relationExistsPushDown: "never", schema, sql: harness.sql });

            for (const { args, table } of cases) {
                // eslint-disable-next-line no-await-in-loop -- sequential keeps the two reads paired per case
                const pushedPage = await pushed.findMany(table, args);
                // eslint-disable-next-line no-await-in-loop -- paired with the push-down read above
                const semijoinPage = await semijoin.findMany(table, args);

                expect(ids(pushedPage.page)).toStrictEqual(ids(semijoinPage.page));
            }
        });

        it("actually emits a correlated EXISTS subquery (no silent fallback to the semijoin)", async () => {
            expect.assertions(2);

            runShardMigrations(harness.sql, schema);

            const queries: string[] = [];
            const capturing: SqlExec = {
                exec: <Row = Record<string, unknown>>(query: string, ...params: unknown[]) => {
                    queries.push(query);

                    return harness.sql.exec<Row>(query, ...params);
                },
            };
            const writer = createShardContextDatabase({ clock: () => 1_700_000_000_000, relationExistsPushDown: "always", schema, sql: capturing });

            await seed(writer);

            queries.length = 0;

            const { page } = await writer.findMany("messages", { where: { author: { is: { name: "Ada" } } } });

            expect(ids(page)).toStrictEqual(["m1", "m2"]);
            // The push-down compiles the relation node inline — exactly one
            // SELECT carrying an EXISTS, and no separate child fetch.
            expect(queries.some((query) => /SELECT.*EXISTS \(SELECT 1 FROM/su.test(query))).toBe(true);
        });

        it("stamps a read dependency on the child table so subscriptions refresh on child writes", async () => {
            expect.assertions(1);

            runShardMigrations(harness.sql, schema);

            const reads: { idOrScan?: string; table: string }[] = [];
            const writer = createShardContextDatabase({
                clock: () => 1_700_000_000_000,
                onRead: (table, idOrScan) => {
                    reads.push({ idOrScan, table });
                },
                relationExistsPushDown: "always",
                schema,
                sql: harness.sql,
            });

            await seed(writer);

            reads.length = 0;

            // The EXISTS subquery reads `users` inline (no child fetch), so the
            // reader must stamp the dependency itself or a `users` write would
            // silently fail to invalidate this live query.
            await writer.findMany("messages", { where: { author: { is: { name: "Ada" } } } });

            expect(reads).toContainEqual({ idOrScan: "*scan", table: "users" });
        });

        it("stamps the child dependency on the semijoin path too (no EXISTS push-down)", async () => {
            expect.assertions(1);

            runShardMigrations(harness.sql, schema);

            const reads: { idOrScan?: string; table: string }[] = [];
            const writer = createShardContextDatabase({
                clock: () => 1_700_000_000_000,
                onRead: (table, idOrScan) => {
                    reads.push({ idOrScan, table });
                },
                // Force the universal semijoin path: the child is fetched through
                // this DO's own `findMany`, which must stamp the `users` read so a
                // `users` write still invalidates the live query — the EXISTS
                // strategy is not in play here, so this pins the other half.
                relationExistsPushDown: "never",
                schema,
                sql: harness.sql,
            });

            await seed(writer);

            reads.length = 0;

            await writer.findMany("messages", { where: { author: { is: { name: "Ada" } } } });

            expect(reads.some((read) => read.table === "users")).toBe(true);
        });

        it("honours relationBaseWhere (RLS) inside the subquery, identically to the semijoin", async () => {
            expect.assertions(2);

            const pushed = makePushWriter();

            await seed(pushed);

            const semijoin = createShardContextDatabase({ clock: () => 1_700_000_000_000, relationExistsPushDown: "never", schema, sql: harness.sql });

            // The child read policy hides every message except body "hi", so the
            // only readable child is Ada's m1 — `some: {}` must match Ada alone.
            // If the EXISTS body dropped the RLS base, Linus (m3 "hey") would
            // leak in, so this pins the subquery's fail-closed merge.
            const args: QueryArgs = {
                relationBaseWhere: (table) => (table === "messages" ? { body: "hi" } : undefined),
                where: { messages: { some: {} } },
            };

            const pushedPage = await pushed.findMany("users", args);
            const semijoinPage = await semijoin.findMany("users", args);

            expect(ids(pushedPage.page)).toStrictEqual(["u1"]);
            expect(ids(pushedPage.page)).toStrictEqual(ids(semijoinPage.page));
        });
    });

    describe("maxRelationKeys fail-closed cap", () => {
        it("throws rather than building an unbounded IN when the child key set exceeds the cap", async () => {
            expect.assertions(1);

            // A fetcher returning more distinct join keys than the cap allows.
            // The semijoin path projects `authorId` off these rows (the to-many
            // `messages` relation's child FK), so six distinct values overflow a
            // cap of five and must fail closed rather than truncate.
            const fetcher = async (): Promise<QueryPage> => {
                return {
                    continueCursor: null,
                    isDone: true,
                    page: Array.from({ length: 6 }, (_, index) => {
                        return { authorId: `a${String(index)}` };
                    }),
                };
            };

            await expect(resolveRelationPredicates({ messages: { some: {} } }, { fetcher, maxRelationKeys: 5, schema, tableName: "users" })).rejects.toThrow(
                /exceeding the 5-key limit/u,
            );
        });

        it("escalates to a correlated EXISTS (not a throw) on overflow when the relation is co-located", async () => {
            expect.assertions(2);

            // Same over-cap fetcher, but now the relation is push-eligible
            // (`canPushExists` → true). The cost-based `"auto"` policy must NOT
            // fail closed: it escalates the oversized node to the unbounded
            // EXISTS push-down, leaving a `__relationExists` marker for the
            // compiler instead of a flat `IN (...)`.
            let fetched = 0;
            const fetcher = async (): Promise<QueryPage> => {
                fetched += 1;

                return {
                    continueCursor: null,
                    isDone: true,
                    page: Array.from({ length: 6 }, (_, index) => {
                        return { authorId: `a${String(index)}` };
                    }),
                };
            };

            const resolved = await resolveRelationPredicates(
                { messages: { some: {} } },
                { canPushExists: () => true, fetcher, maxRelationKeys: 5, schema, tableName: "users" },
            );

            // The probe fetch ran (that's how overflow is detected) and the node
            // came back as an EXISTS marker, not a flat key clause.
            expect(fetched).toBe(1);
            expect(Object.keys(resolved ?? {})).toContain(RELATION_EXISTS_KEY);
        });

        it("auto stays on the cheap semijoin (no EXISTS marker) when the key set is under the cap", async () => {
            expect.assertions(1);

            // Push-eligible, but the child set fits the cap — `"auto"` keeps the
            // faster semijoin and emits a flat clause, never escalating.
            const fetcher = async (): Promise<QueryPage> => {
                return {
                    continueCursor: null,
                    isDone: true,
                    page: [{ authorId: "a0" }, { authorId: "a1" }],
                };
            };

            const resolved = await resolveRelationPredicates(
                { messages: { some: {} } },
                { canPushExists: () => true, fetcher, maxRelationKeys: 5, schema, tableName: "users" },
            );

            expect(Object.keys(resolved ?? {})).not.toContain(RELATION_EXISTS_KEY);
        });
    });
});
