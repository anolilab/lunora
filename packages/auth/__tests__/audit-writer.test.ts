import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAuthAuditReader, createAuthAuditWriter } from "../src/audit";
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
});
