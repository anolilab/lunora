import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverMaskStrategies } from "../src/discover-mask-procedures";

// A self-contained branded builder + mask DSL — the same shape the
// discover-mask-procedures / discover-mask-metadata tests use. `.use` returns
// the same builder so the `.use(mask(...)).query(...)` chain type-checks and
// the chain walk finds the `mask(...)` call. `discoverMaskStrategies` reads the
// strategy off each column property initializer (string literal vs.
// function), so the policies are spelled out as inline object literals.
const PREAMBLE = `
    type Strategy = "hash" | "redact" | ((value: unknown, ctx: unknown) => unknown);
    type MaskPolicies = Record<string, Record<string, Strategy>>;
    declare const mask: (policies: MaskPolicies, options?: { roles?: unknown[] }) => (options: { ctx: unknown }) => unknown;
    declare const query: <R>(config: { args: Record<string, unknown>; handler: (ctx: unknown) => R }) => { kind: "query" };

    interface QueryBuilder<Args> {
        readonly __lunoraProcedure: "query";
        use: <C>(middleware: (options: { ctx: unknown }) => C) => QueryBuilder<Args>;
        query: <R>(handler: (options: { args: Args; ctx: unknown }) => R) => { kind: "query" };
    }

    declare const c: {
        query: QueryBuilder<Record<never, never>>;
    };
`;

// One procedure masking three columns: a "hash" literal on a PII-shaped column
// (email), a "redact" literal on another (ssn), and a function (→ opaque,
// never statically known) on a non-PII column (note).
const USERS = `${PREAMBLE}
    export const listMasked = c.query
        .use(mask({ users: { email: "hash", note: (value) => value, ssn: "redact" } }))
        .query(({ ctx }) => ctx.db.query("users").collect());

    // A bare-factory procedure — no builder chain, so it contributes nothing.
    export const peek = query({ args: {}, handler: () => null });
`;

let workdir: string;
let project: Project;

const rowsFor = () => discoverMaskStrategies(project, join(workdir, "lunora"));

describe("discoverMaskStrategies", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-mask-strategies-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "lunora", "users.ts"), USERS, "utf8");
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it('captures a column whose strategy is the literal "hash"', () => {
        expect.assertions(1);

        const row = rowsFor().find((strategy) => strategy.column === "email");

        expect(row).toMatchObject({ column: "email", exportName: "listMasked", strategy: "hash", table: "users" });
    });

    it('captures a column whose strategy is the literal "redact"', () => {
        expect.assertions(1);

        const row = rowsFor().find((strategy) => strategy.column === "ssn");

        expect(row).toMatchObject({ column: "ssn", exportName: "listMasked", strategy: "redact", table: "users" });
    });

    it("records the file relative to the lunora dir and a 1-based line", () => {
        expect.assertions(2);

        const row = rowsFor().find((strategy) => strategy.column === "email");

        expect(row?.file).toBe("users");
        expect(row?.line).toBeGreaterThan(0);
    });

    it("yields nothing for a column whose strategy is a function (not a static literal)", () => {
        expect.assertions(1);

        const row = rowsFor().find((strategy) => strategy.column === "note");

        expect(row).toBeUndefined();
    });

    it("ignores a bare-factory procedure with no mask chain", () => {
        expect.assertions(1);

        const rows = rowsFor();

        expect(rows.every((strategy) => strategy.exportName !== "peek")).toBe(true);
    });
});
