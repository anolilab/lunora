import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveShard } from "@lunora/platform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NodeShard } from "../src/node-shard-registry";
import { createNodeShardRegistry } from "../src/node-shard-registry";

/**
 * The registry is what turns a resolvable shard key into a *reachable* shard.
 * Its predecessor resolved to a stub that echoed the key back, which satisfied
 * the TCK's directory legs while making cross-shard fan-out impossible — so
 * these assert the two properties `@lunora/runtime`'s query coordinator
 * actually depends on: a resolved stub dispatches into a real shard, and the
 * fan-out key set survives a restart.
 */
describe("createNodeShardRegistry", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-shard-registry-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("gives each shard key its own isolated database", () => {
        expect.assertions(2);

        const registry = createNodeShardRegistry();

        try {
            const a = registry.shardFor("tenant-a");
            const b = registry.shardFor("tenant-b");

            a.shard.sql.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)");
            a.shard.sql.exec("INSERT INTO t (id) VALUES (1)");

            expect(a.shard.sql.exec("SELECT id FROM t").toArray()).toHaveLength(1);

            // `tenant-b` must not see `tenant-a`'s table at all — one shard per
            // key means one database per key, not one database with a column.
            expect(() => b.shard.sql.exec("SELECT id FROM t").toArray()).toThrow("no such table: t");
        } finally {
            registry.close();
        }
    });

    it("hands back the same live shard for a repeated key", () => {
        expect.assertions(1);

        const registry = createNodeShardRegistry();

        try {
            registry.shardFor("tenant-a").shard.sql.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)");
            registry.shardFor("tenant-a").shard.sql.exec("INSERT INTO t (id) VALUES (1)");

            // Written through one resolution, read through another: a registry
            // that reopened the database per resolution would lose the write on
            // an in-memory shard, and deadlock or diverge on a file-backed one.
            expect(registry.shardFor("tenant-a").shard.sql.exec("SELECT id FROM t").toArray()).toHaveLength(1);
        } finally {
            registry.close();
        }
    });

    it("dispatches a resolved stub into the shard handler", async () => {
        expect.assertions(2);

        const seen: string[] = [];
        const registry = createNodeShardRegistry({
            onFetch: (request, shard: NodeShard) => {
                seen.push(shard.shardKey);

                return new Response(`${shard.shardKey}:${new URL(request.url).pathname}`);
            },
        });

        try {
            const response = await resolveShard(registry.directory, "tenant-42").fetch(new Request("http://localhost/query"));

            // This is the exact call shape the query coordinator makes on every
            // fan-out leg (`resolveShard(namespace, key).fetch(...)`).
            await expect(response.text()).resolves.toBe("tenant-42:/query");
            expect(seen).toStrictEqual(["tenant-42"]);
        } finally {
            registry.close();
        }
    });

    it("seeds the fan-out key set from shards already on disk", () => {
        expect.assertions(3);

        const first = createNodeShardRegistry({ directory: workdir });

        first.shardFor("tenant-a");
        first.shardFor("tenant-b");

        expect([...first.listShardKeys()].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["tenant-a", "tenant-b"]);

        first.close();

        // A fresh registry stands in for a process restart. Without the seed,
        // `listShardKeys()` is empty until each shard is touched again — and a
        // fan-out over an empty key set returns no rows, which is
        // indistinguishable from "no rows matched".
        const second = createNodeShardRegistry({ directory: workdir });

        try {
            expect([...second.listShardKeys()].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["tenant-a", "tenant-b"]);
            expect(readdirSync(workdir).filter((entry) => entry.endsWith(".sqlite3"))).toHaveLength(2);
        } finally {
            second.close();
        }
    });

    it("round-trips a shard key that is not filesystem-safe", () => {
        expect.assertions(2);

        // Legal shard keys, illegal path segments: a tenant id with a slash, a
        // room name with a space and a colon. A registry that wrote these
        // straight to disk would create directories, collide, or throw.
        const keys = ["tenant/42", "room:general chat"];
        const first = createNodeShardRegistry({ directory: workdir });

        for (const key of keys) {
            first.shardFor(key);
        }

        first.close();

        const second = createNodeShardRegistry({ directory: workdir });

        try {
            expect([...second.listShardKeys()].toSorted((a, b) => a.localeCompare(b))).toStrictEqual([...keys].toSorted((a, b) => a.localeCompare(b)));
            expect(readdirSync(workdir).some((entry) => entry.includes("/"))).toBe(false);
        } finally {
            second.close();
        }
    });
});
