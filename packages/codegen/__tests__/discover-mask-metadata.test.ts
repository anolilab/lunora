import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverMaskHasNonLiteralPolicy, discoverMaskMetadata } from "../src/discover-mask-procedures";

// A self-contained branded builder + mask DSL — the same shape the
// discover-mask-procedures test uses. `.use` returns the same builder so the
// `.use(mask(...)).query(...)` chain type-checks and the chain walk finds the
// `mask(...)` call. `discoverMaskMetadata` reads the strategy off each column
// property initializer (string literal vs. function), so the policies are
// spelled out as inline object literals.
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

// A builder-form query masking three columns with each strategy kind: a
// "hash" literal on email, another "hash" literal on name, and a function
// (→ "custom") on phone. `admin.ts` re-masks `users.email` as "redact"; since
// files are iterated in alphabetical order (`admin.ts` before `users.ts`),
// admin's "redact" is the first declaration and wins the dedupe.
const USERS = `${PREAMBLE}
    export const list = c.query
        .use(mask({ users: { email: "hash", name: "hash", phone: (value) => value } }))
        .query(() => null);

    // A bare-factory procedure — no builder chain, so it contributes nothing.
    export const peek = query({ args: {}, handler: () => null });
`;

// The alphabetically-first file. It declares `users.email` as "redact"; because
// it is discovered before `users.ts`, this first declaration wins the dedupe
// over users.ts's "hash".
const ADMIN = `${PREAMBLE}
    export const audit = c.query
        .use(mask({ users: { email: "redact" } }))
        .query(() => null);
`;

let workdir: string;
let project: Project;

describe("discoverMaskMetadata", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-mask-meta-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "lunora", "users.ts"), USERS, "utf8");
        writeFileSync(join(workdir, "lunora", "admin.ts"), ADMIN, "utf8");
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("extracts each masked column's table + strategy", () => {
        expect.assertions(2);

        const { columns } = discoverMaskMetadata(project, join(workdir, "lunora"));

        expect(columns).toContainEqual({ column: "name", strategy: "hash", table: "users" });
        expect(columns).toContainEqual({ column: "phone", strategy: "custom", table: "users" });
    });

    it("maps a function strategy to `custom` (the closure is never read)", () => {
        expect.assertions(1);

        const { columns } = discoverMaskMetadata(project, join(workdir, "lunora"));

        expect(columns.find((column) => column.column === "phone")?.strategy).toBe("custom");
    });

    it("dedupes by (table, column) with the first declaration's strategy winning", () => {
        expect.assertions(2);

        const { columns } = discoverMaskMetadata(project, join(workdir, "lunora"));

        const email = columns.filter((column) => column.table === "users" && column.column === "email");

        expect(email).toHaveLength(1);
        // admin.ts sorts before users.ts → its "redact" is the first declaration
        // and wins over users.ts's "hash".
        expect(email[0]?.strategy).toBe("redact");
    });

    it("ignores bare-factory procedures with no mask chain", () => {
        expect.assertions(1);

        const { columns } = discoverMaskMetadata(project, join(workdir, "lunora"));

        // Only the masked columns are listed; `peek` contributes none.
        expect(columns.every((column) => column.table === "users")).toBe(true);
    });
});

describe("discoverMaskHasNonLiteralPolicy", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-mask-nonliteral-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("is false when every mask() policies argument is an inline object literal", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "users.ts"), USERS, "utf8");

        expect(discoverMaskHasNonLiteralPolicy(project, join(workdir, "lunora"))).toBe(false);
    });

    it("is true when a mask() call's policies argument is a hoisted reference, not an object literal", () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "lunora", "users.ts"),
            `${PREAMBLE}
    const sharedPolicies = { users: { email: "redact" } };

    export const list = c.query.use(mask(sharedPolicies)).query(() => null);
`,
            "utf8",
        );

        expect(discoverMaskHasNonLiteralPolicy(project, join(workdir, "lunora"))).toBe(true);
    });

    it("is false for a project with no mask() calls at all", () => {
        expect.assertions(1);

        writeFileSync(
            join(workdir, "lunora", "users.ts"),
            `${PREAMBLE}
    export const peek = query({ args: {}, handler: () => null });
`,
            "utf8",
        );

        expect(discoverMaskHasNonLiteralPolicy(project, join(workdir, "lunora"))).toBe(false);
    });
});
