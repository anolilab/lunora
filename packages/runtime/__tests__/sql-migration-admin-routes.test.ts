import { describe, expect, it, vi } from "vitest";

import { LunoraError } from "../src/errors";
import type { SqlMigrationApplier } from "../src/sql-migration-admin-routes";
import { buildSqlMigrationAdminRoutes, SQL_MIGRATIONS_PATH } from "../src/sql-migration-admin-routes";

const ORIGIN = "http://localhost";

const post = (body: unknown): Request =>
    new Request(`${ORIGIN}${SQL_MIGRATIONS_PATH}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

const handlerFor = (applier: SqlMigrationApplier | undefined, assertAdmin = vi.fn<(request: Request) => void>()) => {
    const routes = buildSqlMigrationAdminRoutes({ applySqlMigrations: applier, assertAdmin });

    return routes[SQL_MIGRATIONS_PATH] as (request: Request) => Promise<Response>;
};

describe("the /_lunora/admin/sql-migrations route", () => {
    it("hands the files and the two flags to the applier, and returns its per-file result", async () => {
        expect.assertions(3);

        const applier = vi.fn<SqlMigrationApplier>(async () => {
            return {
                files: [{ destructive: [], name: "a.sql", skipped: [], state: "ran", statements: ["CREATE TABLE a (id TEXT)"] }],
            };
        });

        const response = await handlerFor(applier)(
            post({ confirmDestructive: true, dryRun: false, files: [{ name: "a.sql", sql: "CREATE TABLE a (id TEXT);" }] }),
        );

        expect(applier).toHaveBeenCalledWith({
            baseline: false,
            confirmDestructive: true,
            dryRun: false,
            files: [{ name: "a.sql", sql: "CREATE TABLE a (id TEXT);" }],
        });
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ files: [{ name: "a.sql", state: "ran" }] });
    });

    it("defaults both flags to false, so a bare request can never confirm a destructive run", async () => {
        expect.assertions(1);

        const applier = vi.fn<SqlMigrationApplier>(async () => {
            return { files: [] };
        });

        await handlerFor(applier)(post({ files: [] }));

        expect(applier).toHaveBeenCalledWith({ baseline: false, confirmDestructive: false, dryRun: false, files: [] });
    });

    it("passes baseline through, and refuses a baseline flag that is not a boolean", async () => {
        expect.assertions(3);

        const applier = vi.fn<SqlMigrationApplier>(async () => {
            return { files: [] };
        });

        await handlerFor(applier)(post({ baseline: true, files: [] }));

        expect(applier).toHaveBeenCalledWith({ baseline: true, confirmDestructive: false, dryRun: false, files: [] });
        await expect(handlerFor(applier)(post({ baseline: "yes", files: [] }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(applier).toHaveBeenCalledTimes(1);
    });

    it("refuses with the admin gate before it reads the body", async () => {
        expect.assertions(2);

        const applier = vi.fn<SqlMigrationApplier>(async () => {
            return { files: [] };
        });
        const assertAdmin = vi.fn<(request: Request) => void>(() => {
            throw new LunoraError("admin endpoint requires a valid admin bearer", { code: "ADMIN_FORBIDDEN", status: 403 });
        });

        await expect(handlerFor(applier, assertAdmin)(post({ files: [] }))).rejects.toMatchObject({ code: "ADMIN_FORBIDDEN" });
        expect(applier).not.toHaveBeenCalled();
    });

    it("answers not-configured when the worker has no D1 binding to run against", async () => {
        expect.assertions(1);

        await expect(handlerFor(undefined)(post({ files: [] }))).rejects.toMatchObject({ code: "SQL_MIGRATIONS_NOT_CONFIGURED", status: 400 });
    });

    it("rejects a file entry without a string name and sql", async () => {
        expect.assertions(2);

        const applier = vi.fn<SqlMigrationApplier>(async () => {
            return { files: [] };
        });

        await expect(handlerFor(applier)(post({ files: [{ name: "a.sql" }] }))).rejects.toMatchObject({ code: "BAD_REQUEST", status: 400 });
        expect(applier).not.toHaveBeenCalled();
    });

    it("rejects a non-boolean flag rather than reading it as false", async () => {
        expect.assertions(2);

        const applier = vi.fn<SqlMigrationApplier>(async () => {
            return { files: [] };
        });

        await expect(handlerFor(applier)(post({ confirmDestructive: "yes", files: [] }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(applier).not.toHaveBeenCalled();
    });
});
