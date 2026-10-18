/**
 * Proves, on workerd's real SQLite, that a secret value written through the
 * Cloudflare `SecretValueHost` cannot be read by the shard's SQL-facing paths,
 * and is not listed by `ShardKvStore`.
 *
 * The value lives in the shard's key-value storage (`state.storage.put`), which
 * workerd keeps in a hidden SQLite table. The table name is visible in
 * `sqlite_master`; its key and value columns are not. These legs pin that from
 * the same entry points the Studio uses: the read-only SQL gate's statement
 * (`storage.sql.exec`), the data browser's table listing and page read, and the
 * KV surface.
 */
import { SecretValueKeyError } from "@lunora/platform";
import { createSecretValueHost, createShardPlatform } from "@lunora/platform-cloudflare";
import type { SqlExec } from "@lunora/shard-engine";
import { isInternalTableName, readTablePage } from "@lunora/shard-engine";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const SENTINEL = "PLAINTEXT-SENTINEL-7f3a";

/** Names of every table the shard's SQLite reports, as the Studio's "List tables" query sees them. */
const tableNames = (sql: SqlExec): string[] =>
    sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .toArray()
        .map((row) => row.name);

describe("secret values on workerd", () => {
    it("are not listed or read through ShardKvStore, and carry no plaintext in its listing", async () => {
        expect.assertions(5);

        const stub = env.SHARD.get(env.SHARD.idFromName("secret-value-kv"));

        await runInDurableObject(stub, async (_instance, state) => {
            const platform = createShardPlatform(state, env);

            await platform.kv.put("s:visible", { ok: true });

            const ref = await platform.secretValues.put(SENTINEL, { scope: "run-1", ttlMs: 60_000 });
            const listed = await platform.kv.list();

            expect([...listed.keys()]).toStrictEqual(["s:visible"]);
            expect(JSON.stringify([...listed.entries()])).not.toContain(SENTINEL);
            await expect(platform.kv.get(ref)).resolves.toBeUndefined();
            await expect(platform.kv.get(`__lunora_secret_value:${ref}`)).resolves.toBeUndefined();
            await expect(platform.kv.put(`__lunora_secret_value:${ref}`, "overwrite")).rejects.toThrow(TypeError);
        });
    });

    it("keeps the value out of the SQL console, the table listing and the data browser", async () => {
        expect.assertions(6);

        const stub = env.SHARD.get(env.SHARD.idFromName("secret-value-sql"));

        await runInDurableObject(stub, async (_instance, state) => {
            const sql = state.storage.sql as unknown as SqlExec;
            const hostWithClock = createSecretValueHost(state.storage, env);

            await hostWithClock.put(SENTINEL, { scope: "run-1", ttlMs: 60_000 });

            // The hidden table is named in the listing, but the listing is the only
            // thing the SQL surface gives up: the data browser filters it out…
            expect(tableNames(sql)).toContain("_cf_KV");
            expect(isInternalTableName("_cf_KV")).toBe(true);
            expect(() => readTablePage(sql, { table: "_cf_KV" })).toThrow(/_cf_KV/u);

            // …and a SELECT of its columns, or a count of its rows, is refused by the
            // authorizer rather than answered from the value store.
            expect(() => sql.exec("SELECT * FROM _cf_KV").toArray()).toThrow(/SQLITE_AUTH|prohibited/u);
            expect(() => sql.exec("SELECT COUNT(*) AS c FROM _cf_KV").toArray()).toThrow(/SQLITE_AUTH|not authorized/u);
            expect(() => sql.exec("SELECT value FROM _cf_KV").toArray()).toThrow(/SQLITE_AUTH|prohibited/u);
        });
    });

    it("holds only ciphertext in the real storage, reads back through the key, and refuses without one", async () => {
        expect.assertions(4);

        const stub = env.SHARD.get(env.SHARD.idFromName("secret-value-cipher"));

        await runInDurableObject(stub, async (_instance, state) => {
            const platform = createShardPlatform(state, env);
            const ref = await platform.secretValues.put(SENTINEL, { scope: "run-1", ttlMs: 60_000 });
            const everything = JSON.stringify([...(await state.storage.list())]);

            expect(everything).toContain(ref);
            expect(everything).not.toContain(SENTINEL);
            await expect(platform.secretValues.take(ref, { claimant: "step-a", scope: "run-1" })).resolves.toBe(SENTINEL);

            const keyless = createSecretValueHost(state.storage, {});

            await expect(keyless.take(ref, { claimant: "step-a", scope: "run-1" })).rejects.toBeInstanceOf(SecretValueKeyError);
        });
    });
});
