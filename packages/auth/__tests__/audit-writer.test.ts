import { DatabaseSync } from "node:sqlite";

import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAuthAuditReader, createAuthAuditWriter } from "../src/audit";
import { authAuditHook, withAuthAudit } from "../src/audit-hooks";
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

let database: DatabaseSync;
let executor: SqlExecutor;

describe(createAuthAuditWriter, () => {
    beforeEach(() => {
        database = new DatabaseSync(":memory:");
        executor = executorFor(database);
    });

    afterEach(() => {
        database.close();
    });

    it("lands an admin-plane row in the trail the reader serves, with the ids the admin routes copy kept readable", async () => {
        expect.assertions(1);

        // Numeric ids read as phone numbers or codes to value-based redaction, so each key the admin routes write
        // has to be on the identifier allow-list or the row loses its target.
        const ids = {
            accountId: "10001",
            invitationId: "10002",
            keyId: "10003",
            memberId: "10004",
            organizationId: "10005",
            passkeyId: "10006",
            role: "admin",
            roleId: "10007",
            targetUserId: "10008",
            teamId: "10009",
            teamMemberId: "10010",
        };

        await createAuthAuditWriter(executor).write({
            actorId: "admin:oncall",
            detail: { path: "/_lunora/admin/auth/users/ban", ...ids },
            event: "admin-user-ban",
            outcome: "success",
            targetEmail: "guest@example.com",
            ts: 1,
        });

        await expect(createAuthAuditReader(executor).read({})).resolves.toStrictEqual([
            {
                actorId: "admin:oncall",
                detail: { path: "/_lunora/admin/auth/users/ban", ...ids },
                event: "admin-user-ban",
                outcome: "success",
                seq: 1,
                targetEmail: "guest@example.com",
                ts: 1,
            },
        ]);
    });

    it("forwards an admin-plane row to the audit hook's onRecord and trims it to the hook's retention", async () => {
        expect.assertions(2);

        const recorded: string[] = [];
        const after = authAuditHook({
            executor,
            onRecord: (entry) => {
                recorded.push(entry.event);
            },
            retention: 1,
        });
        const writer = createAuthAuditWriter(executor, { options: { hooks: { after } } });

        await writer.write({ actorId: "admin:root", detail: {}, event: "admin-user-ban", outcome: "success", ts: 1 });
        await writer.write({ actorId: "admin:root", detail: {}, event: "admin-user-unban", outcome: "success", ts: 2 });

        expect(recorded).toStrictEqual(["admin-user-ban", "admin-user-unban"]);
        await expect(createAuthAuditReader(executor).read({})).resolves.toStrictEqual([expect.objectContaining({ event: "admin-user-unban" })]);
    });

    it("finds the hook config withAuthAudit installed on a createAuth instance", async () => {
        expect.assertions(1);

        const recorded: string[] = [];
        const options = {
            baseURL: "http://localhost",
            database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
            hooks: {},
            secret: "x".repeat(32),
        };
        const auth = createAuth(
            withAuthAudit(options, {
                executor,
                onRecord: (entry) => {
                    recorded.push(entry.event);
                },
            }),
        );

        await createAuthAuditWriter(executor, auth).write({ actorId: "admin:root", detail: {}, event: "admin-user-ban", outcome: "success", ts: 1 });

        expect(recorded).toStrictEqual(["admin-user-ban"]);
    });

    it("keeps a row whose onRecord throws, as the hook does", async () => {
        expect.assertions(1);

        const after = authAuditHook({
            executor,
            onRecord: () => {
                throw new Error("sink down");
            },
        });

        await createAuthAuditWriter(executor, { options: { hooks: { after } } }).write({
            actorId: "admin:root",
            detail: {},
            event: "admin-user-ban",
            outcome: "success",
            ts: 1,
        });

        await expect(createAuthAuditReader(executor).read({})).resolves.toHaveLength(1);
    });

    it("accepts the generated worker's absent auth instance (null) and records with no hook config", async () => {
        expect.assertions(1);

        // `getAuth()` answers null in a worker built without auth options; the generated wiring passes it straight in.
        await createAuthAuditWriter(executor, null).write({ actorId: "admin:root", detail: {}, event: "admin-user-ban", outcome: "success", ts: 1 });

        await expect(createAuthAuditReader(executor).read({})).resolves.toHaveLength(1);
    });
});
