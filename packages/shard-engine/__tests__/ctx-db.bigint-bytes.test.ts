import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { encodeDocJson } from "../src/do-sql";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * `v.bigint()` / `v.bytes()` round-trip through the DO row store (plan 265).
 *
 * Before this fix the store's document blob serialized with a raw
 * `JSON.stringify` and read back with a bare `JSON.parse`:
 *
 * - `JSON.stringify(1n)` **throws** (`TypeError: Do not know how to serialize
 * a BigInt`) — a `v.bigint()` column made `ctx.db.insert` fail outright.
 * - `JSON.stringify(new ArrayBuffer(n))` silently yields `{}` — a `v.bytes()`
 * column's write "succeeds" while the payload is permanently lost.
 *
 * `encodeDocJson` / `decodeDocJson` (`../src/do-sql.ts`) now route the blob
 * through the shared wire codec (`shared/wire-codec.ts`) so both round-trip.
 * A document with neither leaf still encodes byte-identically to plain
 * `JSON.stringify` (asserted below) — the property the OCC compare-and-swap
 * and every `json_extract(__doc__, …)` read depend on for existing rows.
 */
const schema: SchemaLike = {
    tables: {
        accounts: {
            indexes: [],
            shape: {
                amount: { kind: "bigint" },
                blob: { kind: "bytes" },
                deletedAt: { kind: "number" },
                name: { kind: "string" },
            },
            softDeleteMode: { field: "deletedAt" },
        },
    },
};

let harness: ReturnType<typeof createSqliteExec>;

const setup = (): DatabaseWriterLike => {
    runShardMigrations(harness.sql, schema);

    return createShardContextDatabase({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
};

describe("ctx-db bigint/bytes doc-blob round-trip", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    describe("v.bigint()", () => {
        it("insert/get round-trips a bigint column (pre-fix: insert throws)", async () => {
            expect.assertions(1);

            const writer = setup();

            await writer.insert("accounts", { _id: "a1", amount: 10n, name: "acme" }, { allowExplicitId: true });

            const row = await writer.get("a1");

            expect(row?.["amount"]).toBe(10n);
        });

        it("findMany round-trips a bigint column", async () => {
            expect.assertions(1);

            const writer = setup();

            await writer.insert("accounts", { _id: "a1", amount: 10n, name: "acme" }, { allowExplicitId: true });

            const { page } = await writer.findMany("accounts", {});

            expect(page[0]?.["amount"]).toBe(10n);
        });

        it("patch preserves a previously-stored bigint column", async () => {
            expect.assertions(1);

            const writer = setup();

            await writer.insert("accounts", { _id: "a1", amount: 10n, name: "acme" }, { allowExplicitId: true });
            await writer.patch("a1", { name: "acme2" });

            const row = await writer.get("a1");

            expect(row?.["amount"]).toBe(10n);
        });

        it("patch can itself write a bigint column", async () => {
            expect.assertions(1);

            const writer = setup();

            await writer.insert("accounts", { _id: "a1", name: "acme" }, { allowExplicitId: true });
            await writer.patch("a1", { amount: 99n });

            const row = await writer.get("a1");

            expect(row?.["amount"]).toBe(99n);
        });
    });

    describe("v.bytes()", () => {
        it("insert/get round-trips a bytes column with identical bytes (pre-fix: reads back {})", async () => {
            expect.assertions(2);

            const writer = setup();
            const bytes = new Uint8Array([1, 2, 3, 255]).buffer;

            await writer.insert("accounts", { _id: "a1", blob: bytes, name: "acme" }, { allowExplicitId: true });

            const row = await writer.get("a1");

            expect(row?.["blob"]).toBeInstanceOf(ArrayBuffer);
            expect(new Uint8Array(row?.["blob"] as ArrayBuffer)).toStrictEqual(new Uint8Array([1, 2, 3, 255]));
        });

        it("patch preserves a previously-stored bytes column", async () => {
            expect.assertions(1);

            const writer = setup();
            const bytes = new Uint8Array([9, 8, 7]).buffer;

            await writer.insert("accounts", { _id: "a1", blob: bytes, name: "acme" }, { allowExplicitId: true });
            await writer.patch("a1", { name: "acme2" });

            const row = await writer.get("a1");

            expect(new Uint8Array(row?.["blob"] as ArrayBuffer)).toStrictEqual(new Uint8Array([9, 8, 7]));
        });

        it("replace round-trips a bytes column in the new document", async () => {
            expect.assertions(1);

            const writer = setup();
            const bytes = new Uint8Array([1, 1, 2, 3, 5]).buffer;

            await writer.insert("accounts", { _id: "a1", blob: new Uint8Array([0]).buffer, name: "acme" }, { allowExplicitId: true });
            await writer.replace("a1", { blob: bytes, name: "acme2" });

            const row = await writer.get("a1");

            expect(new Uint8Array(row?.["blob"] as ArrayBuffer)).toStrictEqual(new Uint8Array([1, 1, 2, 3, 5]));
        });

        it("soft delete's re-stamped doc preserves the bytes column", async () => {
            expect.assertions(1);

            const writer = setup();
            const bytes = new Uint8Array([42, 42]).buffer;

            await writer.insert("accounts", { _id: "a1", blob: bytes, name: "acme" }, { allowExplicitId: true });
            await writer.delete("a1", "accounts");

            const row = await writer.get("a1", "accounts");

            expect(new Uint8Array(row?.["blob"] as ArrayBuffer)).toStrictEqual(new Uint8Array([42, 42]));
        });
    });

    describe("backward compatibility", () => {
        it("a doc with no bigint/bytes/Date leaves encodes byte-identically to plain JSON.stringify", () => {
            expect.assertions(1);

            const plainDoc = { _creationTime: 1, _id: "a1", name: "acme", nested: { flag: true, list: [1, 2, 3], missing: null } };

            expect(encodeDocJson(plainDoc)).toBe(JSON.stringify(plainDoc));
        });

        it("a row stored as plain JSON before this codec shipped still reads through ctx.db.get", async () => {
            expect.assertions(1);

            const writer = setup();
            const legacyDoc = { _creationTime: 1_700_000_000_000, _id: "legacy-1", name: "legacy" };

            // Bypass the writer entirely — insert the row exactly as it would have
            // been written pre-fix (bare `JSON.stringify`, no wire-codec tags).
            harness.raw("INSERT INTO accounts (id, _creationTime, __doc__) VALUES (?, ?, ?)", "legacy-1", 1_700_000_000_000, JSON.stringify(legacyDoc));

            const row = await writer.get("legacy-1", "accounts");

            expect(row).toMatchObject({ _id: "legacy-1", name: "legacy" });
        });
    });
});
