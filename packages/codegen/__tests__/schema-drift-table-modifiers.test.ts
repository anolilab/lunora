/**
 * The table-level dimensions the structural snapshot records BESIDES its fields,
 * indexes and relations: which physical store a `.global()` table lives on, and
 * the three modifiers that move or destroy rows without touching a column —
 * `.memory()`, `.ttl()` and `.commitOrdered()`.
 *
 * Each was invisible to the snapshot, so the pre-deploy gate reported "no
 * change" for a deploy that relocates the store or deletes rows:
 *
 * `.global()` ⇄ `.global({ backend: "hyperdrive" })` routes the table to a
 * different physical database (`global-backend.ts`) and no rows follow.
 * `.memory()` makes `clearMemoryTables` run `DELETE FROM <table>` in every shard
 * on the next cold start. `.ttl(field, { after })` makes the alarm sweep delete
 * every row already past the cutoff. `.commitOrdered()` leaves every pre-existing
 * row without `_commitSeq`, so a `_commitSeq > cursor` changefeed never offers
 * them.
 *
 * Plus the shard-key encoding: a `.shardBy(KEY)` whose argument is not a string
 * literal is discovered as the sentinel `_unknown_`, which made two DIFFERENT
 * shard keys compare equal and a genuine re-shard read as no change at all.
 */
import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import type { DriftChange, SchemaSnapshot } from "../../../shared/schema-snapshot";
import { diffSchemaSnapshots, SCHEMA_SNAPSHOT_VERSION } from "../../../shared/schema-snapshot";
import discoverSchema from "../src/discover/schema";
import type { SchemaIR, TableIR } from "../src/ir";
import { buildSchemaSnapshot } from "../src/schema-drift";

const stringField = { kind: "string" } as const;

/** Build a minimal `TableIR`; extras carry the modifier under test. */
const table = (name: string, extra: Partial<TableIR> = {}): TableIR => {
    return {
        indexes: [],
        name,
        rankIndexes: [],
        relations: [],
        searchIndexes: [],
        shape: { body: stringField },
        shardMode: "root",
        vectorIndexes: [],
        ...extra,
    };
};

const schema = (tables: TableIR[], jurisdiction?: SchemaIR["jurisdiction"]): SchemaIR => {
    return { jurisdiction, tables, vectorIndexes: [] };
};

/** Snapshot one table declared with `extra`, so a diff pair reads as two one-line declarations. */
const snapshotOf = (extra: Partial<TableIR> = {}): SchemaSnapshot => buildSchemaSnapshot(schema([table("rows", extra)]), []);

/** The changes between two single-table snapshots. */
const driftBetween = (before: Partial<TableIR>, after: Partial<TableIR>): ReadonlyArray<DriftChange> =>
    diffSchemaSnapshots(snapshotOf(before), snapshotOf(after)).changes;

/** The single change a modifier flip must produce — asserting the count keeps a duplicate report from passing. */
const soleChange = (before: Partial<TableIR>, after: Partial<TableIR>): DriftChange => {
    const changes = driftBetween(before, after);

    expect(changes).toHaveLength(1);

    return changes[0] as DriftChange;
};

/** Discover a schema from source, so the sentinel under test is the one discovery actually writes. */
const discover = (source: string): SchemaIR => {
    const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    const schemaPath = "/virtual/lunora/schema.ts";

    project.createSourceFile(schemaPath, source);

    return discoverSchema(project, schemaPath);
};

describe("schema-drift — table modifiers", () => {
    describe("global backend", () => {
        it("encodes which physical store a `.global()` table lives on", () => {
            expect.assertions(3);

            expect(snapshotOf({ globalBackend: "d1", shardMode: "global" }).tables.rows?.shardMode).toBe("global:d1");
            expect(snapshotOf({ globalBackend: "hyperdrive", shardMode: "global" }).tables.rows?.shardMode).toBe("global:hyperdrive");
            // `globalBackend` is optional on hand-built IR and discovery normalises
            // the absent case to `"d1"` — so must this.
            expect(snapshotOf({ shardMode: "global" }).tables.rows?.shardMode).toBe("global:d1");
        });

        it("reports D1 → Hyperdrive as a breaking re-home", () => {
            expect.assertions(4);

            const change = soleChange({ globalBackend: "d1", shardMode: "global" }, { globalBackend: "hyperdrive", shardMode: "global" });

            expect(change.type).toBe("changedShardMode");
            expect(change.severity).toBe("breaking");
            // A `defineMigration` runs inside one shard; it cannot move rows
            // between two different databases.
            expect(change.remediation).toBe("rehome");
        });

        it("does not report drift against a baseline written before the backend was encoded", () => {
            expect.assertions(2);

            /*
             * Every existing app's committed baseline says bare `"global"`, which
             * recorded BOTH flavours. It cannot say which one it was, so neither
             * comparison means anything — and reporting a breaking re-home per
             * global table on the first run after the upgrade is how
             * `--allow-schema-drift` becomes reflexive. One re-blessed baseline
             * later the dimension is live.
             */
            const legacy: SchemaSnapshot = {
                migrationIds: [],
                tables: { rows: { fields: { body: { kind: "string", optional: false } }, indexes: {}, relations: {}, shardMode: "global" } },
                version: SCHEMA_SNAPSHOT_VERSION,
            };

            expect(diffSchemaSnapshots(legacy, snapshotOf({ globalBackend: "d1", shardMode: "global" })).changes).toStrictEqual([]);
            expect(diffSchemaSnapshots(legacy, snapshotOf({ globalBackend: "hyperdrive", shardMode: "global" })).changes).toStrictEqual([]);
        });
    });

    describe(".memory()", () => {
        it("records the flag", () => {
            expect.assertions(2);

            expect(snapshotOf({ memory: true }).tables.rows?.memory).toBe(true);
            expect(snapshotOf().tables.rows?.memory).toBe(false);
        });

        it("reports becoming a memory table as breaking", () => {
            expect.assertions(4);

            const change = soleChange({}, { memory: true });

            expect(change.type).toBe("changedMemoryMode");
            expect(change.severity).toBe("breaking");
            // `clearMemoryTables` runs `DELETE FROM` on every cold start; no
            // per-row transform survives that, so a migration must not excuse it.
            expect(change.remediation).toBe("rehome");
        });

        it("reports dropping `.memory()` as safe", () => {
            expect.assertions(3);

            const change = soleChange({ memory: true }, {});

            expect(change.severity).toBe("safe");
            expect(change.remediation).toBe("none");
        });
    });

    describe(".ttl()", () => {
        const ttl = (field: string, after?: number): Partial<TableIR> => {
            return { ttl: after === undefined ? { field } : { after, field } };
        };

        it("records the policy", () => {
            expect.assertions(2);

            expect(snapshotOf(ttl("expiresAt", 1000)).tables.rows?.ttl).toStrictEqual({ after: 1000, field: "expiresAt" });
            expect(snapshotOf().tables.rows?.ttl).toBeUndefined();
        });

        it("reports a newly declared TTL as breaking", () => {
            expect.assertions(4);

            const change = soleChange({}, ttl("expiresAt", 1000));

            expect(change.type).toBe("changedTtlPolicy");
            expect(change.severity).toBe("breaking");
            // Rewriting the expiry column on the rows already on disk IS the fix,
            // and that is exactly what a `defineMigration` does.
            expect(change.remediation).toBe("backfill");
        });

        it("reports a SHORTENED `after` as breaking and a LENGTHENED one as safe", () => {
            expect.assertions(6);

            /*
             * `selectExpiredIds` computes `cutoff = now - after`, so a larger
             * `after` yields a smaller cutoff and strictly FEWER matches: no row
             * that used to survive the sweep starts being deleted. Shrinking it
             * moves the cutoff forward and deletes rows that were safe yesterday.
             */
            const shortened = soleChange(ttl("expiresAt", 60_000), ttl("expiresAt", 1000));
            const lengthened = soleChange(ttl("expiresAt", 1000), ttl("expiresAt", 60_000));

            expect(shortened.severity).toBe("breaking");
            expect(shortened.remediation).toBe("backfill");
            expect(lengthened.severity).toBe("safe");
            expect(lengthened.remediation).toBe("none");
        });

        it("treats an absent `after` as a zero offset rather than as a different policy", () => {
            expect.assertions(3);

            // `after` omitted ⇒ the column IS the absolute expiry, i.e. offset 0.
            // Adding an offset only ever postpones an expiry.
            expect(driftBetween(ttl("expiresAt"), ttl("expiresAt", 0))).toStrictEqual([]);
            expect(soleChange(ttl("expiresAt"), ttl("expiresAt", 1000)).severity).toBe("safe");
        });

        it("reports a repointed expiry column as breaking, and a dropped policy as safe", () => {
            expect.assertions(5);

            const repointed = soleChange(ttl("expiresAt", 1000), ttl("purgeAt", 1000));
            const dropped = soleChange(ttl("expiresAt", 1000), {});

            expect(repointed.severity).toBe("breaking");
            expect(repointed.remediation).toBe("backfill");
            expect(dropped.severity).toBe("safe");
        });
    });

    describe(".commitOrdered()", () => {
        it("records the flag", () => {
            expect.assertions(2);

            expect(snapshotOf({ commitOrdered: true }).tables.rows?.commitOrdered).toBe(true);
            expect(snapshotOf().tables.rows?.commitOrdered).toBe(false);
        });

        it("reports opting in as breaking, fixable by a backfill", () => {
            expect.assertions(4);

            const change = soleChange({}, { commitOrdered: true });

            expect(change.type).toBe("changedCommitOrdering");
            expect(change.severity).toBe("breaking");
            // `writer.replace` spreads `commitSeqFields(...)`, so a migration that
            // returns the row unchanged stamps it — the one case here a
            // `defineMigration` genuinely repairs.
            expect(change.remediation).toBe("backfill");
        });

        it("reports opting out as breaking, fixable in the consumer", () => {
            expect.assertions(4);

            const change = soleChange({ commitOrdered: true }, {});

            expect(change.severity).toBe("breaking");
            // Nothing happens to stored data — the rows keep the sequence they
            // were written with. It is the changefeed query that stops advancing.
            expect(change.remediation).toBe("code");
            expect(change.summary).toContain("_commitSeq");
        });
    });

    it("does not diff modifiers a pre-modifier baseline never recorded", () => {
        expect.assertions(1);

        /*
         * The shape every committed baseline has on disk today: no `memory`, no
         * `commitOrdered`, no `ttl`. Absence there means "this format did not
         * record it", not "the table declares none" — the same reason
         * `recordsFieldDetail` gates the field-detail comparison.
         */
        const legacy: SchemaSnapshot = {
            migrationIds: [],
            tables: { rows: { fields: { body: { kind: "string", optional: false } }, indexes: {}, relations: {}, shardMode: "root" } },
            version: SCHEMA_SNAPSHOT_VERSION,
        };

        expect(diffSchemaSnapshots(legacy, snapshotOf({ commitOrdered: true, memory: true, ttl: { after: 5, field: "expiresAt" } })).changes).toStrictEqual([]);
    });

    describe("unresolved shard key", () => {
        it("does not let two DIFFERENT non-literal shard keys compare equal", () => {
            expect.assertions(4);

            /*
             * Discovery reads `.shardBy(...)` syntactically, so a non-literal
             * argument is recorded as the sentinel `_unknown_` — one string for
             * every key there is. Two genuinely different shard keys therefore
             * produced byte-identical snapshots and a real re-home reported as no
             * change at all. Verified through `discoverSchema`, not a hand-built
             * IR, so the sentinel under test is the one discovery writes.
             */
            const byOrg = discover(`
                import { defineSchema, defineTable, v } from "@lunora/server";

                const SHARD_KEY = "orgId";

                export const schema = defineSchema({
                    rows: defineTable({ orgId: v.string(), teamId: v.string() }).shardBy(SHARD_KEY),
                });
            `);
            const byTeam = discover(`
                import { defineSchema, defineTable, v } from "@lunora/server";

                const SHARD_KEY = "teamId";

                export const schema = defineSchema({
                    rows: defineTable({ orgId: v.string(), teamId: v.string() }).shardBy(SHARD_KEY),
                });
            `);

            const { changes } = diffSchemaSnapshots(buildSchemaSnapshot(byOrg, []), buildSchemaSnapshot(byTeam, []));

            expect(changes).toHaveLength(1);
            expect(changes[0]?.severity).toBe("breaking");
            expect(changes[0]?.remediation).toBe("rehome");
            // The operator has to be told what to DO about it; the key is
            // unreadable to codegen until they inline it.
            expect(changes[0]?.summary).toContain("string literal");
        });

        it("still reports a literal key normally", () => {
            expect.assertions(1);

            expect(driftBetween({ shardMode: { field: "orgId", kind: "shardBy" } }, { shardMode: { field: "orgId", kind: "shardBy" } })).toStrictEqual([]);
        });
    });

    describe("changes that must stay breaking", () => {
        it.each([
            ["root → shardBy", {}, { shardMode: { field: "orgId", kind: "shardBy" } }],
            ["shardBy:x → shardBy:y", { shardMode: { field: "orgId", kind: "shardBy" } }, { shardMode: { field: "teamId", kind: "shardBy" } }],
            ["shardBy → global", { shardMode: { field: "orgId", kind: "shardBy" } }, { shardMode: "global" }],
            ["global → root", { shardMode: "global" }, {}],
        ])("%s re-homes the rows", (_label, before, after) => {
            expect.assertions(4);

            const change = soleChange(before, after);

            expect(change.severity).toBe("breaking");
            expect(change.remediation).toBe("rehome");
            expect(change.summary).toContain("export/import");
        });

        it("a removed table and a changed jurisdiction both re-home", () => {
            expect.assertions(4);

            const removed = diffSchemaSnapshots(snapshotOf(), buildSchemaSnapshot(schema([]), [])).changes;
            const rejurisdicted = diffSchemaSnapshots(
                buildSchemaSnapshot(schema([table("rows")], "eu"), []),
                buildSchemaSnapshot(schema([table("rows")], "us"), []),
            ).changes;

            expect(removed[0]?.severity).toBe("breaking");
            expect(removed[0]?.remediation).toBe("rehome");
            expect(rejurisdicted[0]?.severity).toBe("breaking");
            expect(rejurisdicted[0]?.remediation).toBe("rehome");
        });
    });

    it("sees every modifier through a real `discoverSchema` run", () => {
        expect.assertions(5);

        const before = discover(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                cache: defineTable({ body: v.string() }),
                events: defineTable({ body: v.string() }),
                globals: defineTable({ body: v.string() }).global(),
                sessions: defineTable({ expiresAt: v.number() }),
            });
        `);
        const after = discover(`
            import { defineSchema, defineTable, v } from "@lunora/server";

            export const schema = defineSchema({
                cache: defineTable({ body: v.string() }).memory(),
                events: defineTable({ body: v.string() }).commitOrdered(),
                globals: defineTable({ body: v.string() }).global({ backend: "hyperdrive" }),
                sessions: defineTable({ expiresAt: v.number() }).ttl("expiresAt", { after: 1000 }),
            });
        `);

        const { changes } = diffSchemaSnapshots(buildSchemaSnapshot(before, []), buildSchemaSnapshot(after, []));
        const byTable = Object.fromEntries(changes.map((change) => [change.table, change]));

        expect(changes).toHaveLength(4);
        expect(byTable.cache?.type).toBe("changedMemoryMode");
        expect(byTable.events?.type).toBe("changedCommitOrdering");
        expect(byTable.globals?.type).toBe("changedShardMode");
        expect(byTable.sessions?.type).toBe("changedTtlPolicy");
    });
});
