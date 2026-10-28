import type { DriftChange, TableIR, ValidatorIR } from "@lunora/codegen";
import { encodeWire } from "@lunora/wire";
import { describe, expect, it } from "vitest";

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
        const text = rows.map((row) => `${JSON.stringify(row)}\n`).join("");

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
});
