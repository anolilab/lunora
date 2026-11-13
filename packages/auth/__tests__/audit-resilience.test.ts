import { DatabaseSync } from "node:sqlite";

import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildAuditEntry, withAuthAudit } from "../src/audit-hooks";
import { createAuth } from "../src/create-auth";
import type { SqlExecutor } from "../src/sql-store";

const SECRET = "x".repeat(32);
const seedMemoryDatabase = (): Record<string, unknown[]> => {
    return { account: [], rateLimit: [], session: [], twoFactor: [], user: [], verification: [] };
};

describe("a failing audit write never fails the auth request", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("completes the sign-up and logs the failure to the console", async () => {
        expect.assertions(2);

        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const failing: SqlExecutor = {
            all: () => Promise.reject(new Error("database unavailable")),
            run: () => Promise.reject(new Error("database unavailable")),
        };
        const auth = createAuth(
            withAuthAudit(
                { database: memoryAdapter(seedMemoryDatabase()), emailAndPassword: { enabled: true }, hooks: {}, secret: SECRET },
                { executor: failing },
            ),
        );

        const response = await auth.handler(
            new Request("http://localhost/api/auth/sign-up/email", {
                body: JSON.stringify({ email: "ada@example.com", name: "Ada", password: "correct horse battery staple" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

        expect(response.status).toBe(200);
        expect(consoleError).toHaveBeenCalledWith("@lunora/auth: audit hook failed to record event", expect.any(Error));
    });
});

describe("a recorded event is handed to the export tap", () => {
    it("passes the persisted sign-up to onRecord", async () => {
        expect.assertions(1);

        const sqlite = new DatabaseSync(":memory:");
        const executor: SqlExecutor = {
            all: (sql, parameters) => Promise.resolve(sqlite.prepare(sql).all(...(parameters as never[])) as Record<string, unknown>[]),
            run: (sql, parameters) => {
                sqlite.prepare(sql).run(...(parameters as never[]));

                return Promise.resolve();
            },
        };
        const onRecord = vi.fn<(entry: { event: string }) => void>();
        const auth = createAuth(
            withAuthAudit(
                { database: memoryAdapter(seedMemoryDatabase()), emailAndPassword: { enabled: true }, hooks: {}, secret: SECRET },
                { executor, onRecord },
            ),
        );

        await auth.handler(
            new Request("http://localhost/api/auth/sign-up/email", {
                body: JSON.stringify({ email: "grace@example.com", name: "Grace", password: "correct horse battery staple" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

        expect(onRecord).toHaveBeenCalledWith(expect.objectContaining({ event: "sign-up" }));

        sqlite.close();
    });
});

describe("an admin row with no subject names none", () => {
    it("leaves the target unset when an admin request names no user", () => {
        expect.assertions(1);

        const entry = buildAuditEntry({ body: { role: "admin" }, path: "/api/auth/admin/set-role" });

        expect(entry?.detail).not.toHaveProperty("targetUserId");
    });
});
