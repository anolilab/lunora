import type { DriftChange, TableIR, ValidatorIR } from "@lunora/codegen";
import { encodeWire } from "@lunora/wire";
import { describe, expect, it } from "vitest";

import { exportEndLine } from "../../../../shared/export-end";
import type { StreamingFetchLike } from "../../src/commands/data-transfer/shared";
import { checkStoredRows } from "../../src/util/stored-row-check";

const table = (name: string, shape: Record<string, ValidatorIR>, shardMode: TableIR["shardMode"] = "root"): TableIR => {
    return {
        indexes: [],
        name,
        rankIndexes: [],
        relations: [],
        searchIndexes: [],
        shape,
        shardMode,
        vectorIndexes: [],
    };
};

const change = (tableName: string, field: string, type: DriftChange["type"] = "changedFieldShape"): DriftChange => {
    return { field, remediation: "backfill", scope: "table", severity: "breaking", summary: `${type} ${tableName}.${field}`, table: tableName, type };
};

const exporting =
    (rows: ReadonlyArray<{ doc: Record<string, unknown>; table: string }>): StreamingFetchLike =>
    async () => {
        const text = `${rows.map((row) => `${JSON.stringify(row)}\n`).join("")}${exportEndLine(rows.length)}`;

        return {
            body: new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(text));
                    controller.close();
                },
            }),
            json: async () => undefined,
            ok: true,
            status: 200,
            text: async () => text,
        };
    };

const respondingWith =
    (body: string): StreamingFetchLike =>
    async () => {
        return {
            body: new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(body));
                    controller.close();
                },
            }),
            json: async () => undefined,
            ok: true,
            status: 200,
            text: async () => body,
        };
    };

const target = (rows: ReadonlyArray<{ doc: Record<string, unknown>; table: string }>) => {
    return { baseUrl: "https://app.example", fetchImpl: exporting(rows), token: "t" };
};

const ADDRESS: ValidatorIR = {
    kind: "object",
    shape: { city: { kind: "string" }, zip: { inner: { kind: "string", stringMaxLength: 5 }, kind: "optional" } },
};

describe(checkStoredRows, () => {
    it("checks nested shapes, optional and nullable fields, and names each failing row by table, _id and declared field", async () => {
        expect.assertions(1);

        const orders = table(
            "orders",
            { address: ADDRESS, note: { column: { notNull: false }, kind: "string" }, orgId: { kind: "string" }, total: { kind: "bigint" } },
            { field: "orgId", kind: "shardBy" },
        );
        const verdict = await checkStoredRows({
            changes: [change("orders", "address"), change("orders", "note"), change("orders", "total", "changedFieldKind")],
            tables: [orders],
            target: target([
                { doc: encodeWire({ _id: "o1", address: { city: "Oslo" }, note: null, orgId: "acme", total: 5n }) as Record<string, unknown>, table: "orders" },
                { doc: { _id: "o2", address: { city: "Oslo", zip: "123456" }, note: "x", orgId: "acme", total: 1 }, table: "orders" },
                { doc: { _id: "o3", address: { city: "Oslo", country: "NO" }, note: "x", orgId: "beta", total: 1 }, table: "orders" },
            ]),
        });

        expect(verdict).toStrictEqual({
            failures: [
                { field: "address.zip", id: "o2", reason: "longer than 5 characters", table: "orders" },
                { field: "address.*", id: "o3", reason: "holds a property the schema does not declare", table: "orders" },
            ],
            kind: "fails",
            rows: 3,
            truncated: false,
        });
    });

    it("reads a NULL in an optional global column as unset, and a removed field as gone only when no row holds it", async () => {
        expect.assertions(2);

        const settings = table("settings", { theme: { inner: { kind: "string" }, kind: "optional" } }, "global");

        await expect(
            checkStoredRows({
                changes: [change("settings", "theme", "changedFieldKind")],
                tables: [settings],
                target: target([{ doc: { _id: "s1", theme: null }, table: "settings" }]),
            }),
        ).resolves.toStrictEqual({ kind: "conforms", rows: 1, tables: ["settings"] });
        await expect(
            checkStoredRows({
                changes: [change("settings", "legacy", "removedField")],
                tables: [settings],
                target: target([{ doc: { _id: "s1", legacy: 1 }, table: "settings" }]),
            }),
        ).resolves.toMatchObject({ failures: [{ field: "legacy", id: "s1", reason: "is no longer declared, but the row still holds it" }], kind: "fails" });
    });

    it("reads a NULL in a removed global column as unset, but a NULL in a removed shard-local field as still held", async () => {
        expect.assertions(2);

        const rows = target([{ doc: { _id: "n1", nickname: null }, table: "notes" }]);
        const removed = [change("notes", "nickname", "removedField")];

        // A `.global()` column that was never set is stored and exported as SQL NULL.
        await expect(checkStoredRows({ changes: removed, tables: [table("notes", {}, "global")], target: rows })).resolves.toMatchObject({ kind: "conforms" });
        await expect(checkStoredRows({ changes: removed, tables: [table("notes", {})], target: rows })).resolves.toMatchObject({ kind: "fails" });
    });

    it("never reports a stored value that is data: a record key, an undeclared property, or the shard key", async () => {
        expect.assertions(3);

        const prefs = table(
            "prefs",
            {
                byEmail: { keyType: { kind: "string" }, kind: "record", valueType: { kind: "object", shape: { on: { kind: "boolean" } } } },
                owner: { kind: "string" },
            },
            { field: "owner", kind: "shardBy" },
        );
        const verdict = await checkStoredRows({
            changes: [change("prefs", "byEmail")],
            tables: [prefs],
            target: target([
                { doc: { _id: "p1", byEmail: { "ada@example.com": { on: "yes" } }, owner: "tenant-secret" }, table: "prefs" },
                { doc: { _id: "p2", byEmail: { "bob@example.com": { on: true, "carol@example.com": 1 } }, owner: "tenant-secret" }, table: "prefs" },
            ]),
        });
        const report = JSON.stringify(verdict);

        expect(verdict).toMatchObject({ failures: [{ field: "byEmail[*].on" }, { field: "byEmail[*].*" }], kind: "fails" });
        expect(report).not.toMatch(/@example\.com/u);
        expect(report).not.toContain("tenant-secret");
    });

    it("cannot confirm a repointed `v.id()` from stored strings", async () => {
        expect.assertions(1);

        const posts = table("posts", { authorId: { kind: "id", tableName: "orgs" } });

        await expect(
            checkStoredRows({
                changes: [change("posts", "authorId")],
                tables: [posts],
                target: target([{ doc: { _id: "p1", authorId: "u1" }, table: "posts" }]),
            }),
        ).resolves.toMatchObject({ kind: "inconclusive" });
    });

    it("never passes what it cannot check: an unresolved validator, a refinement, or a change rows cannot decide", async () => {
        expect.assertions(3);

        const users = table("users", {
            email: { hasRefinement: true, kind: "string", unmodelledRefinement: true },
            role: { kind: "any", sourceText: "roleValidator" },
        });
        const rows = target([{ doc: { _id: "u1", email: "a@b.c", role: "x" }, table: "users" }]);

        await expect(checkStoredRows({ changes: [change("users", "email")], tables: [users], target: rows })).resolves.toMatchObject({ kind: "inconclusive" });
        await expect(checkStoredRows({ changes: [change("users", "role")], tables: [users], target: rows })).resolves.toMatchObject({ kind: "inconclusive" });
        await expect(checkStoredRows({ changes: [change("users", "email", "addedFieldConstraint")], tables: [users], target: rows })).resolves.toMatchObject({
            kind: "inconclusive",
        });
    });

    it("is inconclusive about an object whose shape codegen could not read, rather than checking it as an empty object", async () => {
        expect.assertions(1);

        const users = table("users", { profile: { kind: "object", shape: {}, unresolvedShape: true } });
        const rows = target([{ doc: { _id: "u1", profile: {} }, table: "users" }]);

        await expect(checkStoredRows({ changes: [change("users", "profile")], tables: [users], target: rows })).resolves.toMatchObject({
            kind: "inconclusive",
        });
    });

    it("confirms a stored bigint against a bigint literal, and fails one that differs", async () => {
        expect.assertions(2);

        const counters = table("counters", { level: { kind: "literal", literalValue: "1n" } });
        const rows = (level: bigint) => target([{ doc: encodeWire({ _id: "c1", level }) as Record<string, unknown>, table: "counters" }]);

        await expect(checkStoredRows({ changes: [change("counters", "level")], tables: [counters], target: rows(1n) })).resolves.toMatchObject({
            kind: "conforms",
        });
        await expect(checkStoredRows({ changes: [change("counters", "level")], tables: [counters], target: rows(2n) })).resolves.toMatchObject({
            kind: "fails",
        });
    });

    it("checks a record's keys against its new key validator, without naming the key", async () => {
        expect.assertions(2);

        const prefs = table("prefs", {
            flags: {
                keyType: {
                    kind: "union",
                    members: [
                        { kind: "literal", literalValue: '"dark"' },
                        { kind: "literal", literalValue: '"compact"' },
                    ],
                },
                kind: "record",
                valueType: { kind: "boolean" },
            },
        });
        const verdict = await checkStoredRows({
            changes: [change("prefs", "flags")],
            tables: [prefs],
            target: target([{ doc: { _id: "p1", flags: { dark: true, "secret-key": false } }, table: "prefs" }]),
        });

        expect(verdict).toMatchObject({ failures: [{ field: "flags[*]", id: "p1", table: "prefs" }], kind: "fails" });
        expect(JSON.stringify(verdict)).not.toContain("secret-key");
    });

    it("treats an export that ends inside a row as incomplete, even when the cut-off text parses as a row", async () => {
        expect.assertions(1);

        const users = table("users", { name: { kind: "number" } });
        const body = JSON.stringify({ doc: { _id: "u1", name: 1 }, table: "users" });
        const fetchImpl = respondingWith(body);

        await expect(
            checkStoredRows({ changes: [change("users", "name")], tables: [users], target: { baseUrl: "https://app.example", fetchImpl, token: "t" } }),
        ).resolves.toMatchObject({ kind: "inconclusive" });
    });

    it.each([
        ["no end marker (cut on a row boundary)", (row: string) => `${row}\n`],
        ["an end marker that counts more rows than were read", (row: string) => `${row}\n${exportEndLine(2)}`],
        ["an end marker that counts fewer rows than were read", (row: string) => `${row}\n${row}\n${exportEndLine(1)}`],
        ["a row after the end marker", (row: string) => `${row}\n${exportEndLine(1)}${row}\n`],
    ])("treats an export with %s as incomplete, never as conforming", async (_label, build) => {
        expect.assertions(1);

        const users = table("users", { name: { kind: "number" } });
        const body = build(JSON.stringify({ doc: { _id: "u1", name: 1 }, table: "users" }));
        const fetchImpl = respondingWith(body);

        await expect(
            checkStoredRows({ changes: [change("users", "name")], tables: [users], target: { baseUrl: "https://app.example", fetchImpl, token: "t" } }),
        ).resolves.toMatchObject({ kind: "inconclusive" });
    });

    it.each([
        ["a malformed export line", { body: '{"name":SENTINEL}\n', ok: true, status: 200 }],
        ["an export line that is not a row", { body: '{"name":"SENTINEL"}\n', ok: true, status: 200 }],
        ["an HTTP error body", { body: '{"error":"row SENTINEL-VALUE failed"}', ok: false, status: 500 }],
    ])("never puts stored text from %s into the inconclusive reason", async (_label, response) => {
        expect.assertions(2);

        const users = table("users", { name: { kind: "number" } });
        const fetchImpl: StreamingFetchLike = async () => {
            return {
                body: new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode(response.body));
                        controller.close();
                    },
                }),
                json: async () => undefined,
                ok: response.ok,
                status: response.status,
                text: async () => response.body,
            };
        };
        const verdict = await checkStoredRows({
            changes: [change("users", "name")],
            tables: [users],
            target: { baseUrl: "https://app.example", fetchImpl, token: "t" },
        });

        expect(verdict).toMatchObject({ kind: "inconclusive" });
        expect(JSON.stringify(verdict)).not.toContain("SENTINEL");
    });

    it("fails a stored geoPoint outside the latitude and longitude ranges", async () => {
        expect.assertions(1);

        const places = table("places", { at: { kind: "geoPoint" } });

        await expect(
            checkStoredRows({
                changes: [change("places", "at")],
                tables: [places],
                target: target([
                    { doc: { _id: "p1", at: { lat: 45, lng: 7 } }, table: "places" },
                    { doc: { _id: "p2", at: { lat: 999, lng: 0 } }, table: "places" },
                ]),
            }),
        ).resolves.toMatchObject({ failures: [{ id: "p2" }], kind: "fails" });
    });

    it("is inconclusive about a validator kind it does not know, rather than failing every row", async () => {
        expect.assertions(1);

        const things = table("things", { value: { kind: "mystery" } });

        await expect(
            checkStoredRows({ changes: [change("things", "value")], tables: [things], target: target([{ doc: { _id: "t1", value: 1 }, table: "things" }]) }),
        ).resolves.toMatchObject({ kind: "inconclusive" });
    });
});
