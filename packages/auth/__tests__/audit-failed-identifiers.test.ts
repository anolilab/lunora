import { DatabaseSync } from "node:sqlite";

import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppendAuthAuditEntry } from "../src/audit";
import { appendAuthAuditEntry, readAuthAuditLog } from "../src/audit";
import { withAuthAudit } from "../src/audit-hooks";
import { createAuth } from "../src/create-auth";
import type { SqlExecutor } from "../src/sql-store";

const executorFor = (database: DatabaseSync): SqlExecutor => {
    return {
        all: (sql, parameters) => Promise.resolve(database.prepare(sql).all(...(parameters as never[])) as Record<string, unknown>[]),
        run: (sql, parameters) => {
            database.prepare(sql).run(...(parameters as never[]));

            return Promise.resolve();
        },
    };
};

const PASTED = "hunter2-pasted-as-an-identifier";

let database: DatabaseSync;
let executor: SqlExecutor;

const failedEntry = (clientId: string): AppendAuthAuditEntry => {
    return {
        detail: { clientId, path: "/api/auth/oauth2/token" },
        event: "token-refresh",
        outcome: "failure",
        ts: 1,
    };
};

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

    it("never stores the hash key's own MAC of the caller's text, which would sign whatever the caller sends", async () => {
        expect.assertions(1);

        await appendAuthAuditEntry(executor, failedEntry(PASTED), { hashKey: "auth-secret-one" });

        const [row] = await readAuthAuditLog(executor, {});
        const encoder = new TextEncoder();
        const rootKey = await crypto.subtle.importKey("raw", encoder.encode("auth-secret-one"), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
        const rootMac = Buffer.from(await crypto.subtle.sign("HMAC", rootKey, encoder.encode(PASTED))).toString("hex");

        expect(row?.detail?.["clientId"]).not.toBe(`hmac-sha256:${rootMac}`);
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

const failedSignIn = (targetEmail: string): AppendAuthAuditEntry => {
    return { detail: { path: "/api/auth/sign-in/email" }, event: "sign-in", outcome: "failure", targetEmail, ts: 1 };
};

describe("a failed sign-in's typed identifier is a keyed digest, not the caller's text", () => {
    beforeEach(() => {
        database = new DatabaseSync(":memory:");
        executor = executorFor(database);
    });

    afterEach(() => {
        database.close();
    });

    it("stores the attempted identifier as an HMAC under the hash key, never the typed text", async () => {
        expect.assertions(2);

        await appendAuthAuditEntry(executor, failedSignIn(PASTED), { hashKey: "auth-secret-one" });

        const [row] = await readAuthAuditLog(executor, {});

        expect(row?.targetEmail).toMatch(/^hmac-sha256:[0-9a-f]{64}$/u);
        expect(JSON.stringify(row)).not.toContain(PASTED);
    });

    it("never stores the hash key's own MAC of the typed identifier", async () => {
        expect.assertions(1);

        await appendAuthAuditEntry(executor, failedSignIn(PASTED), { hashKey: "auth-secret-one" });

        const [row] = await readAuthAuditLog(executor, {});
        const encoder = new TextEncoder();
        const rootKey = await crypto.subtle.importKey("raw", encoder.encode("auth-secret-one"), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
        const rootMac = Buffer.from(await crypto.subtle.sign("HMAC", rootKey, encoder.encode(PASTED))).toString("hex");

        expect(row?.targetEmail).not.toBe(`hmac-sha256:${rootMac}`);
    });

    it("groups one address however it was typed, and gives a different digest under another key", async () => {
        expect.assertions(3);

        await appendAuthAuditEntry(executor, failedSignIn(" Victim@Example.com "), { hashKey: "auth-secret-one" });
        await appendAuthAuditEntry(executor, failedSignIn("victim@example.com"), { hashKey: "auth-secret-one" });
        await appendAuthAuditEntry(executor, failedSignIn("victim@example.com"), { hashKey: "auth-secret-two" });

        // Newest first: the other key's row, then the two rows under the same key.
        const rows = await readAuthAuditLog(executor, {});
        const [otherKey, plain, padded] = rows.map((row) => row.targetEmail);

        expect(padded).toMatch(/^hmac-sha256:/u);
        expect(padded).toBe(plain);
        expect(otherKey).not.toBe(plain);
    });

    it("keeps a successful sign-in's address", async () => {
        expect.assertions(1);

        await appendAuthAuditEntry(executor, { ...failedSignIn("ada@example.com"), outcome: "success" }, { hashKey: "auth-secret-one" });

        const [row] = await readAuthAuditLog(executor, {});

        expect(row?.targetEmail).toBe("ada@example.com");
    });

    it("derives the digest key once for a failed sign-in carrying both a detail identifier and an address", async () => {
        expect.assertions(1);

        // Counted by `sign`, not `importKey`: the shared CryptoKey cache absorbs a second derivation's imports.
        const sign = vi.spyOn(crypto.subtle, "sign");

        await appendAuthAuditEntry(executor, { ...failedSignIn("victim@example.com"), detail: { clientId: PASTED } }, { hashKey: "auth-secret-one" });

        // One derivation plus one digest each for the client id and the address.
        expect(sign).toHaveBeenCalledTimes(3);

        sign.mockRestore();
    });

    it("stores no identifier for a failed sign-in when the writer passes no hash key", async () => {
        expect.assertions(2);

        const persisted = await appendAuthAuditEntry(executor, failedSignIn("victim@example.com"));
        const [row] = await readAuthAuditLog(executor, {});

        expect(row?.targetEmail).toBeUndefined();
        expect(persisted.targetEmail).toBeUndefined();
    });

    it("hands onRecord the digest, not the typed identifier", async () => {
        expect.assertions(2);

        const onRecord = vi.fn<(entry: AppendAuthAuditEntry) => void>();
        const auth = createAuth(
            withAuthAudit(
                {
                    database: memoryAdapter({ account: [], rateLimit: [], session: [], twoFactor: [], user: [], verification: [] }),
                    emailAndPassword: { enabled: true },
                    hooks: {},
                    secret: "x".repeat(32),
                },
                { executor, onRecord },
            ),
        );

        await auth.handler(
            new Request("http://localhost/api/auth/sign-in/email", {
                body: JSON.stringify({ email: "victim@example.com", password: "wrong-password-here" }), // secret-scanner:allow -- test fixture for a failed sign-in, not a credential
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

        const recorded = onRecord.mock.calls.map(([entry]) => entry).find((entry) => entry.event === "sign-in");

        expect(recorded?.outcome).toBe("failure");
        expect(recorded?.targetEmail).toMatch(/^hmac-sha256:[0-9a-f]{64}$/u);
    });
});
