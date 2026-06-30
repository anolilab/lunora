import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, readCdcChanges, runShardMigrations } from "../src/ctx-db";
import { materializeExternalRows } from "../src/external-source-materialize";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Integration round-trip for plan 077's materialize primitive, driven through the
 * real `createShardCtxDb` writer + a real SQLite engine. The pure diff test proves
 * the change computation; this proves the *apply* — that a pulled membership lands
 * in the DO table as the right inserts/updates/deletes AND appends to `__cdc_log`
 * (the property that makes a sourced table live-pokeable to `defineShape`).
 */

const schema: SchemaLike = {
    tables: {
        documents: {
            indexes: [],
            shape: { orgId: { kind: "string" }, title: { kind: "string" } },
        },
    },
};

let harness: ReturnType<typeof createSqliteExec>;

const setupWriter = (): DatabaseWriterLike => {
    runShardMigrations(harness.sql, schema, { cdc: true });

    return createShardContextDatabase({ broadcast: () => undefined, cdc: true, clock: () => 1_700_000_000_000, schema, sql: harness.sql });
};

/** Read the table's current membership as the canonical `id → JSON` baseline (the full-pull baseline the DO derives from its own SQLite). */
const readBaseline = (): Map<string, string> => {
    const rows = harness.sql.exec("SELECT id, __doc__ FROM documents").toArray() as { __doc__: string; id: string }[];

    return new Map(
        rows.map(({ __doc__, id }) => {
            const stored = JSON.parse(__doc__) as Record<string, unknown>;

            return [id, JSON.stringify({ _id: id, orgId: stored.orgId, title: stored.title })];
        }),
    );
};

describe("materializeExternalRows", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("applies inserts, updates, and deletes to bring the table to the pulled membership", async () => {
        expect.assertions(6);

        const writer = setupWriter();

        // Seed the local table: d1, d2, d3.
        await writer.insert("documents", { _id: "d1", orgId: "org_1", title: "one" }, { allowExplicitId: true });
        await writer.insert("documents", { _id: "d2", orgId: "org_1", title: "two" }, { allowExplicitId: true });
        await writer.insert("documents", { _id: "d3", orgId: "org_1", title: "three" }, { allowExplicitId: true });

        // Upstream now: d1 unchanged, d2 retitled, d3 gone, d4 new.
        const pulled = [
            { _id: "d1", orgId: "org_1", title: "one" },
            { _id: "d2", orgId: "org_1", title: "two-edited" },
            { _id: "d4", orgId: "org_1", title: "four" },
        ];

        const { applied, nextBaseline } = await materializeExternalRows(writer, pulled, readBaseline(), { table: "documents" });

        // update d2 + insert d4 + delete d3 = 3 changes.
        expect(applied).toBe(3);

        await expect(writer.get("d2")).resolves.toMatchObject({ _id: "d2", title: "two-edited" });
        await expect(writer.get("d4")).resolves.toMatchObject({ _id: "d4", title: "four" });
        await expect(writer.get("d3")).resolves.toBeNull();

        // The returned baseline reflects the post-tick membership (d1, d2, d4).
        expect([...nextBaseline.keys()].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["d1", "d2", "d4"]);

        // The applied changes appended to the CDC log — so a defineShape subscriber gets poked.
        const { changes } = readCdcChanges(harness.sql);
        const sourcedOps = changes.filter((change) => ["d2", "d3", "d4"].includes(change.id)).map((change) => `${change.op}:${change.id}`);

        // Seed inserts (d2, d3), then the materialize delta in diff order: upserts in pulled order (update d2, insert d4), then deletes (d3).
        expect(sourcedOps).toStrictEqual(["insert:d2", "insert:d3", "update:d2", "insert:d4", "delete:d3"]);
    });

    it("applies nothing and reproduces the baseline on a steady-state tick", async () => {
        expect.assertions(2);

        const writer = setupWriter();

        await writer.insert("documents", { _id: "d1", orgId: "org_1", title: "one" }, { allowExplicitId: true });

        const baseline = readBaseline();
        const pulled = [{ _id: "d1", orgId: "org_1", title: "one" }];

        const { applied, nextBaseline } = await materializeExternalRows(writer, pulled, baseline, { table: "documents" });

        expect(applied).toBe(0);
        expect([...nextBaseline]).toStrictEqual([...baseline]);
    });
});
