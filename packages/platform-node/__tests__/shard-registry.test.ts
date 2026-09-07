import { mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

    it("keeps two shard keys that differ only in case on separate databases", () => {
        expect.assertions(4);

        // APFS and NTFS both default to case-INSENSITIVE, so an encoding that
        // preserved case wrote `Tenant.sqlite3` and `tenant.sqlite3` into ONE
        // file: two connections, two cached `NodeShard`s, one database, and each
        // tenant silently reading and writing the other's rows.
        const first = createNodeShardRegistry({ directory: workdir });

        try {
            const upper = first.shardFor("Tenant");
            const lower = first.shardFor("tenant");

            upper.shard.sql.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)");
            upper.shard.sql.exec("INSERT INTO t (id) VALUES (1)");

            expect(() => lower.shard.sql.exec("SELECT id FROM t").toArray()).toThrow("no such table: t");

            // Both halves matter, and the second is what makes this test mean
            // anything on a case-SENSITIVE volume (Linux CI): two files must
            // exist, AND their basenames must still differ once folded. The old
            // encoding produced one file on APFS/NTFS and two fold-equal names
            // everywhere else — this catches it on either.
            const basenames = readdirSync(workdir).filter((entry) => entry.endsWith(".sqlite3"));

            expect(basenames).toHaveLength(2);
            expect(new Set(basenames.map((entry) => entry.toLowerCase())).size).toBe(2);
        } finally {
            first.close();
        }

        // And both survive the restart seed: `readdirSync` yielding one basename
        // is how the other key dropped out of the fan-out set entirely.
        const second = createNodeShardRegistry({ directory: workdir });

        try {
            expect([...second.listShardKeys()].toSorted((a, b) => (a < b ? -1 : Number(a > b)))).toStrictEqual(["Tenant", "tenant"]);
        } finally {
            second.close();
        }
    });

    it("refuses to boot over a database whose basename does not round-trip", () => {
        expect.assertions(6);

        // A database written by the earlier, case-preserving encoding: the same
        // bytes, under the basename that build produced. Built by renaming a
        // real shard file rather than by touching an empty one, so the "still
        // sitting on disk" half of the defect is real data.
        const first = createNodeShardRegistry({ directory: workdir });

        first.shardFor("Legacy").shard.sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
        first.shardFor("Legacy").shard.sql.exec("INSERT INTO t (id) VALUES (1)");
        first.close();

        const current = readdirSync(workdir).find((entry) => entry.endsWith(".sqlite3"));

        expect(current).toBe("%4Cegacy.sqlite3");

        renameSync(join(workdir, current as string), join(workdir, "Legacy.sqlite3"));

        // Seeding `Legacy` from this file is what made the defect silent:
        // `listShardKeys()` reported the key, and `shardFor("Legacy")` opened
        // `%4Cegacy.sqlite3` — a brand-new empty database — so every fan-out
        // leg returned zero rows and reported success. Nothing here depends on
        // filesystem case-folding: the rename is explicit, so this fails on a
        // case-sensitive volume too.
        let message = "";

        try {
            createNodeShardRegistry({ directory: workdir }).close();
        } catch (error) {
            message = (error as Error).message;
        }

        // The file, the key it decodes to, and the exact rename out.
        expect(message).toContain("Legacy.sqlite3");
        expect(message).toContain('shard key "Legacy"');
        expect(message).toContain("%4Cegacy.sqlite3");

        // And the named rename is the whole migration: the rows come back.
        renameSync(join(workdir, "Legacy.sqlite3"), join(workdir, "%4Cegacy.sqlite3"));

        const second = createNodeShardRegistry({ directory: workdir });

        try {
            expect(second.listShardKeys()).toStrictEqual(["Legacy"]);
            expect(second.shardFor("Legacy").shard.sql.exec("SELECT id FROM t").toArray()).toHaveLength(1);
        } finally {
            second.close();
        }
    });

    it("refuses to boot over a basename that is not valid percent-encoding", () => {
        expect.assertions(1);

        // `decodeURIComponent` throws on this, and an unhandled URIError at boot
        // says nothing about which file caused it.
        writeFileSync(join(workdir, "broken%zz.sqlite3"), "");

        expect(() => createNodeShardRegistry({ directory: workdir })).toThrow("broken%zz.sqlite3");
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
