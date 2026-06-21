import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverMaskProcedures from "../src/discover-mask-procedures";

// A self-contained branded builder + mask DSL. Discovery resolves the
// `__lunoraProcedure` brand off the receiver's *type*, so the builder is
// declared inline (the isolated test project has no workspace module
// resolution). `.use` returns the same builder so the `.use(mask(...)).query(...)`
// chain type-checks and the chain walk finds the `mask(...)` call. `ctx.db`
// exposes the read/write entry points the table-access walk recognises.
const PREAMBLE = `
    // The bare-factory \`query\` must resolve to a \`@lunora/server\` import for the
    // shared classifier to accept it (a locally-declared const is rejected).
    import { query } from "@lunora/server";

    type Strategy = "hash" | "redact" | ((value: unknown, ctx: unknown) => unknown);
    type MaskPolicies = Record<string, Record<string, Strategy>>;
    declare const mask: (policies: MaskPolicies, options?: { roles?: unknown[] }) => (options: { ctx: unknown }) => unknown;

    interface Db {
        query: (table: string) => { collect: () => unknown[] };
        findMany: (table: string) => unknown[];
        findFirst: (table: string) => unknown;
        get: (id: string) => unknown;
        insert: (table: string, value: unknown) => string;
    }
    declare const db: Db;

    interface QueryBuilder<Args> {
        readonly __lunoraProcedure: "query";
        use: <C>(middleware: (options: { ctx: unknown }) => C) => QueryBuilder<Args>;
        query: <R>(handler: (options: { args: Args; ctx: { db: Db } }) => R) => { kind: "query" };
    }

    interface InternalQueryBuilder<Args> {
        readonly __lunoraProcedure: "query";
        readonly __lunoraVisibility: "internal";
        use: <C>(middleware: (options: { ctx: unknown }) => C) => InternalQueryBuilder<Args>;
        query: <R>(handler: (options: { args: Args; ctx: { db: Db } }) => R) => { kind: "query" };
    }

    declare const c: {
        query: QueryBuilder<Record<never, never>>;
        internalQuery: InternalQueryBuilder<Record<never, never>>;
    };
`;

// One builder-form query that masks users.email/phone, and a sibling that reads
// the same table without any mask — the "one masks, one leaks" shape.
const USERS = `${PREAMBLE}
    export const listMasked = c.query
        .use(mask({ users: { email: "redact", phone: (value) => value } }))
        .query(({ ctx }) => ctx.db.query("users").collect());

    // Reads users without .use(mask(...)) → uncovered reader.
    export const listRaw = c.query.query(({ ctx }) => ctx.db.findMany("users"));

    // A bare-factory procedure — no builder chain, so it never masks.
    export const peek = query({ args: {}, handler: () => null });
`;

// An internal reader of the masked table (exempt), and a write-only procedure.
const ADMIN = `${PREAMBLE}
    export const adminExport = c.internalQuery.query(({ ctx }) => ctx.db.findMany("users"));

    export const createUser = c.query.query(({ ctx }) => ctx.db.insert("users", {}));
`;

let workdir: string;
let project: Project;

const procedureFor = (exportName: string) => discoverMaskProcedures(project, join(workdir, "lunora")).find((procedure) => procedure.exportName === exportName);

describe("discoverMaskProcedures", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-mask-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "lunora", "users.ts"), USERS, "utf8");
        writeFileSync(join(workdir, "lunora", "admin.ts"), ADMIN, "utf8");
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records the (table, column) pairs a .use(mask(...)) chain declares", () => {
        expect.assertions(3);

        const masked = procedureFor("listMasked");

        expect(masked?.usesMask).toBe(true);
        expect(masked?.maskColumns).toContainEqual({ column: "email", table: "users" });
        expect(masked?.maskColumns).toContainEqual({ column: "phone", table: "users" });
    });

    it("captures the tables a procedure reads through ctx.db", () => {
        expect.assertions(2);

        const masked = procedureFor("listMasked");

        expect(masked?.tablesRead).toContain("users");
        expect(masked?.tablesWritten).toStrictEqual([]);
    });

    it("marks a sibling reader without a mask chain as usesMask: false", () => {
        expect.assertions(3);

        const raw = procedureFor("listRaw");

        expect(raw?.usesMask).toBe(false);
        expect(raw?.maskColumns).toStrictEqual([]);
        expect(raw?.tablesRead).toContain("users");
    });

    it("classifies an internalQuery procedure as internal visibility", () => {
        expect.assertions(2);

        const admin = procedureFor("adminExport");

        expect(admin?.visibility).toBe("internal");
        expect(admin?.usesMask).toBe(false);
    });

    it("records a write-only procedure's tablesWritten and empty tablesRead", () => {
        expect.assertions(2);

        const create = procedureFor("createUser");

        expect(create?.tablesWritten).toContain("users");
        expect(create?.tablesRead).toStrictEqual([]);
    });

    it("includes a bare-factory procedure with no chain (usesMask: false)", () => {
        expect.assertions(2);

        const peek = procedureFor("peek");

        expect(peek?.usesMask).toBe(false);
        expect(peek?.maskColumns).toStrictEqual([]);
    });
});
