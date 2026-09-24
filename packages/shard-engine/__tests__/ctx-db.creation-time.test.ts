import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BroadcastDelta, DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * `_creationTime` is documented as "when the row was inserted", and every
 * default read order plus every keyset cursor is built on it. So it has to
 * survive a rewrite: a `replace` that re-stamps it moves the row to the end of
 * every `_creationTime`-ordered index, and a paginating client then sees the row
 * twice or never. A `patch` that accepts a forged one writes it into the stored
 * document only, so CDC rows, broadcasts and replicas disagree with what `get`
 * reads back off the column.
 */
const schema: SchemaLike = {
    tables: {
        notes: {
            indexes: [],
            shape: { body: { kind: "string" } },
        },
    },
};

let harness: ReturnType<typeof createSqliteExec>;
let deltas: Parameters<BroadcastDelta>[0][];

/** A writer whose clock advances a second per read, so a re-stamp is unmistakable. */
const setup = (): DatabaseWriterLike => {
    runShardMigrations(harness.sql, schema, { cdc: true });

    let now = 1_700_000_000_000;

    return createShardContextDatabase({
        broadcast: (delta) => deltas.push(delta),
        cdc: true,
        clock: () => {
            now += 1000;

            return now;
        },
        schema,
        sql: harness.sql,
    });
};

describe("ctx-db `_creationTime` across the write verbs", () => {
    beforeEach(() => {
        harness = createSqliteExec();
        deltas = [];
    });

    afterEach(() => {
        harness.close();
    });

    it("replace() preserves the row's original _creationTime", async () => {
        expect.assertions(2);

        const writer = setup();
        const id = await writer.insert("notes", { body: "first" });
        const inserted = await writer.get(id, "notes");

        await writer.replace(id, { body: "second" }, "notes");

        const replaced = await writer.get(id, "notes");

        expect(replaced?.["body"]).toBe("second");
        expect(replaced?.["_creationTime"]).toBe(inserted?.["_creationTime"]);
    });

    it("replace() still honors an explicit _creationTime under allowExplicitId", async () => {
        expect.assertions(1);

        const writer = setup();
        const id = await writer.insert("notes", { body: "first" });

        await writer.replace(id, { _creationTime: 42, body: "second" }, "notes", { allowExplicitId: true });

        const replaced = await writer.get(id, "notes");

        expect(replaced?.["_creationTime"]).toBe(42);
    });

    it("patch() ignores a forged _creationTime in the patch object", async () => {
        expect.assertions(3);

        const writer = setup();
        const id = await writer.insert("notes", { body: "first" });
        const inserted = await writer.get(id, "notes");

        deltas = [];

        await writer.patch(id, { _creationTime: 1, body: "second" }, "notes");

        const patched = await writer.get(id, "notes");
        const logged = harness.raw(`SELECT doc FROM "__cdc_log" WHERE op = 'update' ORDER BY seq DESC LIMIT 1`)[0];
        const loggedDocument = typeof logged?.["doc"] === "string" ? (JSON.parse(logged["doc"]) as Record<string, unknown>) : {};

        // The stored column is what `get` reads back...
        expect(patched?.["_creationTime"]).toBe(inserted?.["_creationTime"]);
        // ...so the broadcast and the CDC row a replica applies must agree with it.
        expect(deltas[0]?.row?.["_creationTime"]).toBe(inserted?.["_creationTime"]);
        expect(loggedDocument["_creationTime"]).toBe(inserted?.["_creationTime"]);
    });
});
