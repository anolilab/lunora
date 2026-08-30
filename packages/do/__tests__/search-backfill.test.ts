import type { SchemaLike, SearchBackfillProgress, SqlExec } from "@lunora/shard-engine";
import { ADMIN_FUNCTIONS, backfillSearchIndexes, createShardCtxDb as createShardContextDatabase, runShardMigrations } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * `__lunora_admin__:backfillSearch` — the out-of-band exit from `staged: true`.
 *
 * A staged search index is skipped by every migration pass on purpose, so
 * without a caller for `backfillSearchIndexes` the rows that predate the index
 * are unsearchable forever. This asserts the admin RPC is that caller: it
 * routes, it is bearer-gated like its siblings, and it reaches the schema-aware
 * override the codegen subclass installs.
 *
 * The end-to-end assertion is FTS5-only — without the module the reader falls
 * back to a LIKE scan over the document table and never consults a companion,
 * so there is no staleness to observe. Routing and gating are engine-agnostic.
 */

const ADMIN_TOKEN = "s3cret-admin";

/** Whether this Node build's `node:sqlite` carries the FTS5 module (22.14 does not, 22.23 and 24 do). */
const FTS5_IN_BUILD = ((): boolean => {
    const probe = createSqliteExec();

    try {
        probe.raw(`CREATE VIRTUAL TABLE "__fts5_build_probe__" USING fts5(x)`);

        return true;
    } catch {
        return false;
    } finally {
        probe.close();
    }
})();

/** The schema as it was BEFORE the search index was declared — how the pre-existing rows got written. */
const priorSchema: SchemaLike = {
    tables: {
        docs: {
            indexes: [],
            shape: { body: { kind: "string" }, title: { kind: "string" } },
        },
    },
};

/** The same table after a `.searchIndex(..., { staged: true })` is added and deployed. */
const stagedSchema: SchemaLike = {
    tables: {
        docs: {
            indexes: [],
            searchIndexes: [{ field: "body", name: "by_body", staged: true }],
            shape: { body: { kind: "string" }, title: { kind: "string" } },
        },
    },
};

/**
 * A shard carrying the schema-aware override the emitter now generates. The base
 * class can't see a project's `schema.ts`, so without this the op is reachable
 * but has nothing to run — exactly the split the generated subclass fills.
 */
class SearchShard extends ShardDO {
    // eslint-disable-next-line class-methods-use-this -- override stub; admin RPCs never dispatch through it
    public override handleRpc(): Promise<unknown> {
        return Promise.reject(new Error("handleRpc must not run for admin RPCs"));
    }

    protected override runShardSearchBackfill(options: { maxPages?: number }): SearchBackfillProgress {
        return backfillSearchIndexes(this.sql as SqlExec, stagedSchema, options);
    }
}

const adminRequest = (functionPath: string, args: Record<string, unknown>, token?: string): Request => {
    const headers: Record<string, string> = { "content-type": "application/json" };

    if (token !== undefined) {
        headers.authorization = `Bearer ${token}`;
    }

    return new Request("https://shard.internal/rpc", {
        body: JSON.stringify({ args, functionPath }),
        headers,
        method: "POST",
    });
};

describe("backfillSearch admin RPC", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let state: ShardDOState;

    beforeEach(() => {
        database = createSqliteExec();
        state = {
            acceptWebSocket() {},
            getWebSockets() {
                return [];
            },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        };
    });

    afterEach(() => {
        database.close();
    });

    it("is gated by the admin bearer like the sibling ops", async () => {
        expect.assertions(2);

        const shard = new SearchShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });

        const missing = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.backfillSearch, {}));
        const wrong = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.backfillSearch, {}, "nope"));

        expect(missing.status).toBe(403);
        expect(wrong.status).toBe(403);
    });

    it.runIf(FTS5_IN_BUILD)("indexes the rows that predate a staged index, and reports its progress", async () => {
        expect.assertions(4);

        // Deploy 1: no search index yet, so nothing syncs these rows anywhere.
        runShardMigrations(database.sql, priorSchema);

        const writer = createShardContextDatabase({ schema: priorSchema, sql: database.sql });

        await writer.insert("docs", { body: "hello world", title: "a" });
        await writer.insert("docs", { body: "goodbye world", title: "b" });

        // Deploy 2: the staged index arrives — companion provisioned, backfill skipped.
        runShardMigrations(database.sql, stagedSchema);

        const search = async (): Promise<unknown[]> => {
            const rows = await createShardContextDatabase({ schema: stagedSchema, sql: database.sql })
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "hello"))
                .collect();

            return rows.map((document) => document["title"]);
        };

        await expect(search()).resolves.toStrictEqual([]);

        const shard = new SearchShard(state, { LUNORA_ADMIN_TOKEN: ADMIN_TOKEN });
        const response = await shard.fetch(adminRequest(ADMIN_FUNCTIONS.backfillSearch, { maxPages: 5 }, ADMIN_TOKEN));

        expect(response.status).toBe(200);

        const body = await response.json<{ result: SearchBackfillProgress }>();

        expect(body.result).toStrictEqual({ done: true, pages: 1 });
        await expect(search()).resolves.toStrictEqual(["a"]);
    });
});
