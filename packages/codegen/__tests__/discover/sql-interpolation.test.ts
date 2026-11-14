import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverSqlInterpolation from "../../src/discover/sql-interpolation";

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

/** A `const` text built from a substitution template, then passed by name — the hop must be followed. */
const CONST_HOP = `
    export const search = async (ctx, args) => {
        const q = \`SELECT * FROM t WHERE a = '\${args.a}'\`;
        return ctx.sql.query(q);
    };
`;

/** A raw handler argument passed as the text — the caller controls the whole statement. */
const RAW_ARG = `
    export const run = async (ctx, args) => {
        return ctx.sql.query(args.sql);
    };
`;

/** A concatenation hidden behind a parenthesis and a cast. */
const CAST_CONCAT = `
    export const lookup = async (ctx, name) => {
        return ctx.sql.query(("SELECT * FROM t WHERE a = '" + name + "'") as string);
    };
`;

/** A `.join` that splices a handler argument into the statement. */
const JOIN = `
    export const find = async (ctx, args) => {
        return ctx.sql.query(["SELECT * FROM t WHERE a =", args.a].join(" "));
    };
`;

/** A module constant interpolated into a template is fixed text, not an injection vector. */
const MODULE_CONST_TEMPLATE = `
    const TABLE = "users";
    export const byId = async (ctx, id) => {
        return ctx.sql.query(\`SELECT * FROM \${TABLE} WHERE id = $1\`, [id]);
    };
`;

/** A `const` bound to a fixed literal, then passed by name with params — safe. */
const CONST_TEXT_HOP = `
    export const byId = async (ctx, id) => {
        const q = "SELECT * FROM users WHERE id = $1";
        return ctx.sql.query(q, [id]);
    };
`;

/** A `.join` over constant pieces only — the statement is fixed. */
const CONSTANT_JOIN = `
    export const byId = async (ctx, id) => {
        return ctx.sql.query(["SELECT *", "FROM users", "WHERE id = $1"].join(" "), [id]);
    };
`;

/** A `.concat` over constant pieces only — the statement is fixed. */
const CONSTANT_CONCAT = `
    export const byId = async (ctx, id) => {
        return ctx.sql.query("SELECT * FROM users".concat(" WHERE id = $1"), [id]);
    };
`;

/** A `.concat` that appends a handler argument. */
const ARG_CONCAT = `
    export const byName = async (ctx, args) => {
        return ctx.sql.query("SELECT * FROM users WHERE name = ".concat(args.name));
    };
`;

/** Request text passed through two \`const\` aliases. */
const TWO_HOP_ARG = `
    export const run = async (ctx, args) => {
        const first = args.sql;
        const second = first;
        return ctx.sql.query(second);
    };
`;

/** Request text destructured from the handler's \`args\`. */
const DESTRUCTURED_ARG = `
    export const run = async (ctx, args) => {
        const { sql } = args;
        return ctx.sql.query(sql);
    };
`;

/** A plain parameter passed straight through: the caller is not visible here, so it is left alone. */
const PARAM_PASSTHROUGH = `
    export const run = async (ctx, q) => ctx.sql.query(q);
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
        expect(found[0]).toMatchObject({ scope: { kind: "export", name: "search" }, file: "search" });
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

    it("flags text built in a const before being passed to ctx.sql.query", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "const-hop.ts"), CONST_HOP, "utf8");

        expect(discoverSqlInterpolation(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("flags a raw handler argument passed as the text", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "raw-arg.ts"), RAW_ARG, "utf8");

        expect(discoverSqlInterpolation(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("flags a parenthesised, cast concatenation", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "cast-concat.ts"), CAST_CONCAT, "utf8");

        expect(discoverSqlInterpolation(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("flags a .join that splices a handler argument", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "join.ts"), JOIN, "utf8");

        expect(discoverSqlInterpolation(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("does NOT flag a module constant interpolated into a template", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "module-const.ts"), MODULE_CONST_TEMPLATE, "utf8");

        expect(discoverSqlInterpolation(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("does NOT flag a const bound to a fixed literal", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "const-text.ts"), CONST_TEXT_HOP, "utf8");

        expect(discoverSqlInterpolation(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("does NOT flag a .join over constant pieces", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "constant-join.ts"), CONSTANT_JOIN, "utf8");

        expect(discoverSqlInterpolation(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("does NOT flag a .concat over constant pieces", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "constant-concat.ts"), CONSTANT_CONCAT, "utf8");

        expect(discoverSqlInterpolation(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("flags a .concat that appends a handler argument", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "arg-concat.ts"), ARG_CONCAT, "utf8");

        expect(discoverSqlInterpolation(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each([
        ["two const aliases", TWO_HOP_ARG],
        ["a destructure of args", DESTRUCTURED_ARG],
    ])("flags request text reached through %s", (_label, source) => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "hop.ts"), source, "utf8");

        expect(discoverSqlInterpolation(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("does NOT flag a plain parameter passed through as the text", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "passthrough.ts"), PARAM_PASSTHROUGH, "utf8");

        expect(discoverSqlInterpolation(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
