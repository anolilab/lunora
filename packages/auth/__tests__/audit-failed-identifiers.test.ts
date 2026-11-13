import { DatabaseSync } from "node:sqlite";

import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppendAuthAuditEntry } from "../src/audit";
import { appendAuthAuditEntry, readAuthAuditLog } from "../src/audit";
import { createAuth } from "../src/create-auth";
import type { SqlExecutor } from "../src/sql-store";

const executorFor = (database: DatabaseSync): SqlExecutor => {return {
    all: (sql, parameters) => Promise.resolve(database.prepare(sql).all(...(parameters as never[])) as Record<string, unknown>[]),
    run: (sql, parameters) => {
        database.prepare(sql).run(...(parameters as never[]));

        return Promise.resolve();
    },
}};

const PASTED = "hunter2-pasted-as-an-identifier";

let database: DatabaseSync;
let executor: SqlExecutor;

const failedEntry = (clientId: string): AppendAuthAuditEntry => {return {
    detail: { clientId, path: "/api/auth/oauth2/token" },
    event: "token-refresh",
    outcome: "failure",
    ts: 1,
}};

describe("failed-attempt identifiers are keyed digests, not the caller's text", () => {
    beforeEach(() => {
        database = new DatabaseSync(":memory:");
        executor = executorFor(database);
    });

    afterEach(() => {
        database.close();
    });

    it("stores a failed attempt's identifier as an HMAC under the hash key, never the raw value", async () => {
        expect.assertions(2);

        await appendAuthAuditEntry(executor, failedEntry(PASTED), { hashKey: "auth-secret-one" });

        const [row] = await readAuthAuditLog(executor, {});
        const stored = row?.detail?.["clientId"];

        expect(stored).toMatch(/^hmac-sha256:[0-9a-f]{64}$/u);
        expect(JSON.stringify(row)).not.toContain(PASTED);
    });

    it("gives the same digest for the same value under the same key, and a different one under another key", async () => {
        expect.assertions(2);

        await appendAuthAuditEntry(executor, failedEntry(PASTED), { hashKey: "auth-secret-one" });
        await appendAuthAuditEntry(executor, failedEntry(PASTED), { hashKey: "auth-secret-one" });
        await appendAuthAuditEntry(executor, failedEntry(PASTED), { hashKey: "auth-secret-two" });

        const rows = await readAuthAuditLog(executor, {});
        const digests = rows.map((row) => row.detail?.["clientId"]);

        // Two writes share a key and so one digest; the other key gives a second one.
        expect(digests).toHaveLength(3);
        expect(new Set(digests).size).toBe(2);
    });

    it("leaves a failed attempt's identifiers as written when a trusted writer passes no hash key", async () => {
        expect.assertions(2);

        await appendAuthAuditEntry(executor, failedEntry("client_123"));

        const [row] = await readAuthAuditLog(executor, {});

        expect(row?.detail?.["clientId"]).toBe("client_123");
        expect(row?.detail?.["path"]).toBe("/api/auth/oauth2/token");
    });

    it("keeps a successful attempt's identifier as the caller sent it", async () => {
        expect.assertions(1);

        await appendAuthAuditEntry(executor, { ...failedEntry("client_123"), outcome: "success" }, { hashKey: "auth-secret-one" });

        const [row] = await readAuthAuditLog(executor, {});

        expect(row?.detail?.["clientId"]).toBe("client_123");
    });

    it("exposes the auth secret to an after-hook, so the audit hook can key the digest", async () => {
        expect.assertions(1);

        const secrets: unknown[] = [];
        const SECRET = "x".repeat(32);
        const auth = createAuth({
            database: memoryAdapter({ account: [], rateLimit: [], session: [], twoFactor: [], user: [], verification: [] }),
            emailAndPassword: { enabled: true },
            hooks: {
                after: createAuthMiddleware(async (context) => {
                    secrets.push(context.context.secret);
                }),
            },
            secret: SECRET,
        });

        await auth.handler(
            new Request("http://localhost/api/auth/sign-in/email", {
                body: JSON.stringify({ email: "ada@example.com", password: "wrong-password-here" }), // secret-scanner:allow -- test fixture for a failed sign-in, not a credential
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

        expect(secrets).toContain(SECRET);
    });
});
