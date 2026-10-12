import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * A field added to a shipped root / `.shardBy()` schema needs no migration step:
 * the next cold start runs `ALTER TABLE … ADD COLUMN` for it. Two schemas on one
 * shard stand in for two deploys. Rows written before the deploy must keep
 * reading, without the new field, and rows written after it must keep it.
 */
const beforeDeploy: SchemaLike = {
    tables: { notes: { indexes: [], shape: { body: { kind: "string" } } } },
};

const afterDeploy: SchemaLike = {
    tables: { notes: { indexes: [], shape: { body: { kind: "string" }, pinned: { kind: "boolean" } } } },
};

const clock = () => 1_700_000_000_000;

let harness: ReturnType<typeof createSqliteExec>;

describe("runShardMigrations — a field added after the table was provisioned", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("adds the column on the next cold start and keeps both generations of rows readable", async () => {
        expect.assertions(3);

        runShardMigrations(harness.sql, beforeDeploy);

        const oldWriter = createShardContextDatabase({ clock, schema: beforeDeploy, sql: harness.sql });
        const oldId = await oldWriter.insert("notes", { body: "written before the deploy" });

        runShardMigrations(harness.sql, afterDeploy);

        const newWriter = createShardContextDatabase({ clock, schema: afterDeploy, sql: harness.sql });
        const newId = await newWriter.insert("notes", { body: "written after the deploy", pinned: true });

        expect(await newWriter.get(oldId)).toMatchObject({ body: "written before the deploy" });
        expect(await newWriter.get(oldId)).not.toHaveProperty("pinned", true);
        expect(await newWriter.get(newId)).toMatchObject({ body: "written after the deploy", pinned: true });
    });
});
