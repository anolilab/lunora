import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppendAuthAuditEntry } from "../src/audit";
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

describe("audit identifiers survive redaction", () => {
    beforeEach(() => {
        database = new DatabaseSync(":memory:");
        executor = executorFor(database);
    });

    afterEach(() => {
        database.close();
    });

    it("keeps a numeric user id and key id readable in the stored row", async () => {
        expect.assertions(2);

        const entry = buildAuditEntry({ body: { userId: "12345" }, path: "/api/auth/admin/ban-user" });
        const keyEntry = buildAuditEntry({ body: { keyId: "123456789" }, path: "/api/auth/api-key/delete" });

        await appendAuthAuditEntry(executor, entry as AppendAuthAuditEntry);
        await appendAuthAuditEntry(executor, keyEntry as AppendAuthAuditEntry);

        const rows = await readAuthAuditLog(executor, {});

        expect(rows.map((row) => row.detail?.["targetUserId"])).toContain("12345");
        expect(rows.map((row) => row.detail?.["keyId"])).toContain("123456789");
    });

    it("still scrubs a credential from the free-form detail, beside the identifiers", async () => {
        expect.assertions(2);

        await appendAuthAuditEntry(executor, {
            detail: { path: "/api/auth/admin/ban-user", targetUserId: "12345", token: "tok_secret_value" },
            event: "admin-user-ban",
            outcome: "success",
            ts: 1,
        });

        const [row] = await readAuthAuditLog(executor, {});

        expect(JSON.stringify(row?.detail)).not.toContain("tok_secret_value");
        expect(row?.detail?.["targetUserId"]).toBe("12345");
    });

    it("redacts a value under an identifier key that is not a bare token, rather than keeping it", async () => {
        expect.assertions(2);

        await appendAuthAuditEntry(executor, {
            detail: { keyId: "Bearer abc.def secret", targetUserId: "12345", organizationId: { token: "nested-secret-value" } },
            event: "api-key-delete",
            outcome: "failure",
            ts: 1,
        });

        const [row] = await readAuthAuditLog(executor, {});

        expect(JSON.stringify(row?.detail)).not.toMatch(/abc\.def|nested-secret-value/u);
        expect(row?.detail?.["targetUserId"]).toBe("12345");
    });
});
