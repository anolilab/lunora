import { describe, expect, it, vi } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";
import type { SqlMigrationApplier } from "../src/sql-migration-admin-routes";
import { SQL_MIGRATION_BODY_BYTES, SQL_MIGRATIONS_PATH } from "../src/sql-migration-admin-routes";

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const noopNamespace: ShardNamespaceLike = {
    get: () => {
        return { fetch: async () => new Response("not used", { status: 200 }) };
    },
    idFromName: (name) => {
        return { __name: name };
    },
};

const ADMIN_TOKEN = "admin-bear";

/** A request whose body is one file of `bytes` bytes of SQL, with its `Content-Length` declared, as a real client sends. */
const requestWithSqlOf = (bytes: number): Request => {
    const body = JSON.stringify({ files: [{ name: "big.sql", sql: "-- ".padEnd(bytes, "x") }] });

    return new Request(`https://app.example${SQL_MIGRATIONS_PATH}`, {
        body,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-length": String(body.length), "content-type": "application/json" },
        method: "POST",
    });
};

describe("the /_lunora/admin/sql-migrations route at the worker entry point", () => {
    it("accepts a file above the shared 1 MiB JSON cap, because the route declares its own budget", async () => {
        expect.assertions(2);

        const applier = vi.fn<SqlMigrationApplier>(async () => {
            return { files: [] };
        });
        const worker = createWorker({ adminToken: ADMIN_TOKEN, applySqlMigrations: applier, shardDO: noopNamespace });

        const response = await worker.fetch(requestWithSqlOf(2 * 1_048_576), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(applier).toHaveBeenCalledTimes(1);
    });

    it("rejects a request one byte past the route's budget with 413, before the applier runs", async () => {
        expect.assertions(2);

        const applier = vi.fn<SqlMigrationApplier>(async () => {
            return { files: [] };
        });
        const worker = createWorker({ adminToken: ADMIN_TOKEN, applySqlMigrations: applier, shardDO: noopNamespace });

        const response = await worker.fetch(requestWithSqlOf(SQL_MIGRATION_BODY_BYTES + 1), {}, fakeContext);

        expect(response.status).toBe(413);
        expect(applier).not.toHaveBeenCalled();
    });
});
