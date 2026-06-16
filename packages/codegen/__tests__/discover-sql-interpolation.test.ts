import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverSqlInterpolation from "../src/discover-sql-interpolation";

/** A `ctx.sql` template that concatenates raw text into a `${…}` span — the injection smell. */
const CONCAT = `
    export const search = async (ctx, name) => {
        return ctx.sql\`SELECT * FROM users WHERE \${"name = '" + name + "'"}\`;
    };
`;

/** A `ctx.sql` template that nests a template literal into a `${…}` span — also string-building. */
const NESTED = `
    export const lookup = async (ctx, id) => {
        return ctx.sql\`SELECT * FROM t WHERE id = \${\`\${id}\`}\`;
    };
`;

/** A `ctx.sql` template that binds a plain value — safe, parameterized by the driver. */
const SAFE = `
    export const byId = async (ctx, id) => {
        return ctx.sql\`SELECT * FROM users WHERE id = \${id}\`;
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

    it("flags a string-concatenation interpolation in ctx.sql", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "search.ts"), CONCAT, "utf8");

        const found = discoverSqlInterpolation(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "search", file: "search" });
    });

    it("flags a nested template literal interpolation in ctx.sql", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "lookup.ts"), NESTED, "utf8");

        expect(discoverSqlInterpolation(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("does NOT flag a bound value placeholder", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "byid.ts"), SAFE, "utf8");

        expect(discoverSqlInterpolation(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
