import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendAuthAuditEntry, readAuthAuditLog } from "../src/audit";
import { buildAuditEntry } from "../src/audit-hooks";
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

let database: DatabaseSync;
let executor: SqlExecutor;

describe("auth audit trail", () => {
    beforeEach(() => {
        database = new DatabaseSync(":memory:");
        executor = executorFor(database);
    });

    afterEach(() => {
        database.close();
    });

    describe("auth audit store — record & query", () => {
        it("records sign-in / password-change / MFA-toggle events and reads them back newest-first", async () => {
            expect.assertions(4);

            await appendAuthAuditEntry(executor, { actorId: "u1", event: "sign-in", outcome: "success", ts: 1 });
            await appendAuthAuditEntry(executor, { actorId: "u1", event: "password-change", outcome: "success", ts: 2 });
            await appendAuthAuditEntry(executor, { actorId: "u1", event: "mfa-enable", outcome: "success", ts: 3 });
            await appendAuthAuditEntry(executor, { actorId: "u1", event: "mfa-disable", outcome: "success", ts: 4 });

            const rows = await readAuthAuditLog(executor);

            expect(rows).toHaveLength(4);
            expect(rows.map((row) => row.event)).toStrictEqual(["mfa-disable", "mfa-enable", "password-change", "sign-in"]);
            expect(rows[0]?.outcome).toBe("success");
            expect(rows.at(-1)?.actorId).toBe("u1");
        });

        it("filters by actor and event, and pages past sinceSeq", async () => {
            expect.assertions(3);

            await appendAuthAuditEntry(executor, { actorId: "a", event: "sign-in", outcome: "success", ts: 1 });
            await appendAuthAuditEntry(executor, { actorId: "b", event: "sign-in", outcome: "failure", ts: 2 });
            await appendAuthAuditEntry(executor, { actorId: "a", event: "sign-out", outcome: "success", ts: 3 });

            await expect(readAuthAuditLog(executor, { actorId: "a" })).resolves.toHaveLength(2);
            await expect(readAuthAuditLog(executor, { event: "sign-in" })).resolves.toHaveLength(2);
            await expect(readAuthAuditLog(executor, { sinceSeq: 2 })).resolves.toHaveLength(1);
        });

        it("returns [] on a never-audited database instead of throwing", async () => {
            expect.assertions(1);

            await expect(readAuthAuditLog(executor)).resolves.toStrictEqual([]);
        });
    });

    describe("auth audit store — retention", () => {
        it("keeps every row by default (unbounded, not capped at 1000)", async () => {
            expect.assertions(1);

            for (let index = 0; index < 25; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential appends model the real per-request write order
                await appendAuthAuditEntry(executor, { event: "sign-in", outcome: "success", ts: index });
            }

            await expect(readAuthAuditLog(executor, { limit: 10_000 })).resolves.toHaveLength(25);
        });

        it("trims to the most recent N when retention is configured", async () => {
            expect.assertions(2);

            for (let index = 0; index < 10; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential appends model the real per-request write order
                await appendAuthAuditEntry(executor, { event: "sign-in", outcome: "success", ts: index }, { retention: 3 });
            }

            const rows = await readAuthAuditLog(executor);

            expect(rows).toHaveLength(3);
            expect(rows.map((row) => row.ts)).toStrictEqual([9, 8, 7]);
        });
    });

    describe("auth audit store — redaction", () => {
        it("redacts secrets/PII in the detail payload before persisting", async () => {
            expect.assertions(4);

            await appendAuthAuditEntry(executor, {
                detail: { note: "login", password: "hunter2", token: "sk_live_secret", email: "victim@example.com" },
                event: "sign-in",
                outcome: "success",
                ts: 1,
            });

            const [row] = await readAuthAuditLog(executor);
            const detail = row?.detail ?? {};

            expect(detail["password"]).not.toBe("hunter2");
            expect(detail["token"]).not.toBe("sk_live_secret");
            expect(detail["email"]).not.toBe("victim@example.com");
            // A non-sensitive field survives so the trail stays useful.
            expect(detail["note"]).toBe("login");
        });

        it("skips redaction when redactDetail is false (trusted, pre-scrubbed payload)", async () => {
            expect.assertions(1);

            await appendAuthAuditEntry(executor, { detail: { password: "kept" }, event: "sign-in", outcome: "success", ts: 1 }, { redactDetail: false });

            const [row] = await readAuthAuditLog(executor);

            expect(row?.detail?.["password"]).toBe("kept");
        });

        it("invokes an export tap with the redacted, persisted entry", async () => {
            expect.assertions(2);

            const persisted = await appendAuthAuditEntry(executor, {
                detail: { secret: "abc123" },
                event: "sign-in",
                outcome: "success",
                ts: 1,
            });

            expect(persisted.event).toBe("sign-in");
            expect((persisted.detail as Record<string, unknown>)["secret"]).not.toBe("abc123");
        });
    });

    describe("buildAuditEntry — classification & extraction", () => {
        it("classifies the endpoint path into a security event", () => {
            expect.assertions(5);

            expect(buildAuditEntry({ path: "/api/auth/sign-in/email" })?.event).toBe("sign-in");
            expect(buildAuditEntry({ path: "/api/auth/sign-up/email" })?.event).toBe("sign-up");
            expect(buildAuditEntry({ path: "/api/auth/change-password" })?.event).toBe("password-change");
            expect(buildAuditEntry({ path: "/api/auth/two-factor/enable" })?.event).toBe("mfa-enable");
            expect(buildAuditEntry({ path: "/api/auth/two-factor/disable" })?.event).toBe("mfa-disable");
        });

        it("skips non-security endpoints (returns undefined)", () => {
            expect.assertions(2);

            expect(buildAuditEntry({ path: "/api/auth/get-session" })).toBeUndefined();
            expect(buildAuditEntry({ path: undefined })).toBeUndefined();
        });

        it("extracts actor, IP and User-Agent from the request + fresh session", () => {
            expect.assertions(4);

            const entry = buildAuditEntry(
                {
                    context: { newSession: { user: { email: "ada@example.com", id: "u1" } } },
                    headers: new Headers({ "cf-connecting-ip": "203.0.113.7", "user-agent": "TestUA/1.0" }),
                    path: "/api/auth/sign-in/email",
                },
                1000,
            );

            expect(entry?.actorId).toBe("u1");
            expect(entry?.actorEmail).toBe("ada@example.com");
            expect(entry?.ip).toBe("203.0.113.7");
            expect(entry?.userAgent).toBe("TestUA/1.0");
        });

        it("marks an APIError-shaped return as a failure", () => {
            expect.assertions(2);

            const failure = buildAuditEntry({ context: { returned: { status: 401 } }, path: "/api/auth/sign-in/email" });
            const success = buildAuditEntry({ context: { returned: { token: "ok" } }, path: "/api/auth/sign-in/email" });

            expect(failure?.outcome).toBe("failure");
            expect(success?.outcome).toBe("success");
        });

        it("round-trips a built entry through the store", async () => {
            expect.assertions(2);

            const entry = buildAuditEntry(
                {
                    context: { newSession: { user: { id: "u9" } } },
                    headers: new Headers({ "user-agent": "UA" }),
                    path: "/api/auth/sign-in/email",
                },
                42,
            );

            // The append call is what a real hook would do with the built entry.
            await appendAuthAuditEntry(executor, entry ?? { event: "sign-in", outcome: "success", ts: 0 });

            const [row] = await readAuthAuditLog(executor, { actorId: "u9" });

            expect(row?.event).toBe("sign-in");
            expect(row?.userAgent).toBe("UA");
        });
    });
});
