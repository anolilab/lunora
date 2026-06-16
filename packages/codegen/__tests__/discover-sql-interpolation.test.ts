import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverSqlInterpolation from "../src/discover-sql-interpolation";

/** A `ctx.sql.query` whose `text` is a substitution template referencing a handler arg — the injection smell. */
const TEMPLATE = `
    export const search = async (ctx, args) => {
        return ctx.sql.query(\`SELECT * FROM users WHERE email = '\${args.email}'\`);
    };
`;

/** A `ctx.sql.query` whose `text` concatenates raw input — also string-building. */
const CONCAT = `
    export const lookup = async (ctx, name) => {
        return ctx.sql.query("SELECT * FROM users WHERE name = '" + name + "'");
    };
`;

/** A `ctx.sql.unsafe` whose `text` is a substitution template — the `.unsafe` sink is covered too. */
const UNSAFE = `
    export const raw = async (ctx, id) => {
        return ctx.sql.unsafe(\`SELECT * FROM t WHERE id = \${id}\`);
    };
`;

/** A `ctx.sql.query` with a fixed statement + bound params — safe, parameterized by the driver. */
const SAFE = `
    export const byId = async (ctx, id) => {
        return ctx.sql.query("SELECT * FROM users WHERE id = $1", [id]);
    };
`;

let workdir: string;
let project: Project;

describe("discoverSqlInterpolation", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-sql-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("flags a substitution-template text in ctx.sql.query", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "search.ts"), TEMPLATE, "utf8");

        const found = discoverSqlInterpolation(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "search", file: "search" });
    });

    it("flags a string-concatenation text in ctx.sql.query", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "lookup.ts"), CONCAT, "utf8");

        expect(discoverSqlInterpolation(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("flags a substitution-template text in ctx.sql.unsafe", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "raw.ts"), UNSAFE, "utf8");

        expect(discoverSqlInterpolation(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("does NOT flag a fixed statement with bound params", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "byid.ts"), SAFE, "utf8");

        expect(discoverSqlInterpolation(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
