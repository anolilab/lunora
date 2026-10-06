import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { AuthDataPortLike } from "../../src/data-port";
import { createDoAuthWiring } from "../../src/do-wiring";
import { INTERNAL_SECRET } from "./test-worker";

/**
 * The DO-backed auth object's export / import (`$auth`) over real Durable Object
 * SQLite: `PRAGMA table_info` and `INSERT … ON CONFLICT DO NOTHING RETURNING` are
 * exactly what `node:sqlite` could accept and workerd refuse.
 */

const portFor = (objectName: string): AuthDataPortLike => {
    const { dataPort } = createDoAuthWiring({
        internalSecret: INTERNAL_SECRET,
        namespace: { get: (id) => env.AUTH_DO.get(id as DurableObjectId), idFromName: (name) => env.AUTH_DO.idFromName(name) },
        objectName,
    });

    if (!dataPort) {
        throw new Error("a wiring with a secret must expose dataPort");
    }

    return dataPort;
};

const collect = async (port: AuthDataPortLike): Promise<{ doc: Record<string, unknown>; table: string }[]> => {
    const rows: { doc: Record<string, unknown>; table: string }[] = [];

    for await (const row of port.exportRows()) {
        rows.push(row);
    }

    return rows;
};

describe("auth data port on Durable Object SQLite", () => {
    it("exports every table user-first and imports it append-only into another object", async () => {
        expect.hasAssertions();

        const source = portFor("data-port-source");
        const target = portFor("data-port-target");

        // The first read materialises the schema.
        await collect(source);
        await runInDurableObject(env.AUTH_DO.get(env.AUTH_DO.idFromName("data-port-source")), (_instance, state) => {
            for (let index = 0; index < 150; index += 1) {
                state.storage.sql.exec(
                    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, 0, 0)`,
                    `u${String(index)}`,
                    `User ${String(index)}`,
                    `u${String(index)}@example.test`,
                );
            }

            state.storage.sql.exec(`INSERT INTO "session" ("id", "token", "userId", "expiresAt", "createdAt", "updatedAt") VALUES ('s1', 't1', 'u1', 0, 0, 0)`);
        });

        const rows = await collect(source);

        expect(rows.filter((row) => row.table === "user")).toHaveLength(150);
        expect(rows[0]?.table).toBe("user");

        const sessionAt = rows.findIndex((row) => row.table === "session");

        expect(sessionAt).toBeGreaterThan(rows.findLastIndex((row) => row.table === "user"));

        // In batches, as a restore sends them.
        const first = await target.importRows(rows.slice(0, 100));
        const rest = await target.importRows(rows.slice(100));

        expect(first.inserted + rest.inserted).toBe(rows.length);
        expect([...first.errors, ...rest.errors]).toStrictEqual([]);

        const again = await target.importRows(rows);

        expect(again).toStrictEqual({ conflicts: rows.length, errors: [], inserted: 0 });
    });
});
