import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DiagnosticCategory, Project } from "ts-morph";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dialectFromUrl, loadDriver } from "../src/commands/introspect/connect";
import { emitIntrospection, identifierFor, indexedColumns } from "../src/commands/introspect/emit";
import type { IntrospectedDatabase, IntrospectedTable } from "../src/commands/introspect/model";
import { validatorForColumn } from "../src/commands/introspect/model";
import type { SqlExecutor } from "../src/commands/introspect/read-database";
import { readDatabase, resolveType } from "../src/commands/introspect/read-database";

const emitOptions = { procedures: true, serverImport: "@lunora/server" };

const usersTable: IntrospectedTable = {
    columns: [
        { arrayDepth: 0, dataType: "int4", name: "id", nullable: false },
        { arrayDepth: 0, dataType: "text", name: "email", nullable: false },
        { arrayDepth: 0, dataType: "text", name: "display_name", nullable: true },
        { arrayDepth: 0, dataType: "timestamptz", name: "created_at", nullable: false },
    ],
    indexes: [{ columns: ["email"], name: "users_email_key", unique: true }],
    name: "users",
    primaryKey: ["id"],
};

const postsTable: IntrospectedTable = {
    columns: [
        { arrayDepth: 0, dataType: "int4", name: "id", nullable: false },
        { arrayDepth: 0, dataType: "int4", name: "author_id", nullable: false, references: { column: "id", table: "users" } },
        { arrayDepth: 1, dataType: "text", name: "tags", nullable: true },
        { arrayDepth: 0, dataType: "geometry", name: "location", nullable: true },
    ],
    indexes: [],
    name: "posts",
    primaryKey: ["id"],
};

const database: IntrospectedDatabase = { dialect: "postgres", tables: [postsTable, usersTable] };

describe("validatorForColumn", () => {
    it("maps common Postgres types onto v.* validators", () => {
        expect.assertions(4);

        expect(validatorForColumn({ arrayDepth: 0, dataType: "text", name: "a", nullable: false }, "postgres").expression).toBe("v.string()");
        expect(validatorForColumn({ arrayDepth: 0, dataType: "int8", name: "a", nullable: false }, "postgres").expression).toBe("v.bigint()");
        expect(validatorForColumn({ arrayDepth: 0, dataType: "timestamptz", name: "a", nullable: false }, "postgres").expression).toBe("v.timestamp()");
        expect(validatorForColumn({ arrayDepth: 0, dataType: "jsonb", name: "a", nullable: false }, "postgres").expression).toBe("v.any()");
    });

    it("wraps a nullable column in v.optional and an array column in v.array", () => {
        expect.assertions(2);

        expect(validatorForColumn({ arrayDepth: 0, dataType: "text", name: "a", nullable: true }, "postgres").expression).toBe("v.optional(v.string())");
        expect(validatorForColumn({ arrayDepth: 1, dataType: "text", name: "a", nullable: true }, "postgres").expression).toBe(
            "v.optional(v.array(v.string()))",
        );
    });

    it("expresses a foreign key as a branded v.id of the target table", () => {
        expect.assertions(1);

        const column = { arrayDepth: 0, dataType: "int4", name: "author_id", nullable: false, references: { column: "id", table: "users" } };

        expect(validatorForColumn(column, "postgres").expression).toBe('v.id("users")');
    });

    it("falls back to v.any() and reports the type as unknown rather than guessing", () => {
        expect.assertions(2);

        const result = validatorForColumn({ arrayDepth: 0, dataType: "geometry", name: "a", nullable: false }, "postgres");

        expect(result.expression).toBe("v.any()");
        expect(result.known).toBe(false);
    });
});

describe("emitIntrospection — schema module", () => {
    it("emits a defineSchema module with every table marked .global on the hyperdrive backend", () => {
        expect.assertions(4);

        const schema = emitIntrospection(database, emitOptions).files.find((file) => file.path === "schema.ts");

        expect(schema?.contents).toContain('import { defineSchema, defineTable, v } from "@lunora/server";');
        expect(schema?.contents).toContain("users: defineTable({");
        // The rows live in the external database, so sharding into a DO is wrong.
        expect(schema?.contents).toContain('.global({ backend: "hyperdrive" })');
        expect(schema?.contents).toContain("email: v.string(),");
    });

    it("carries the source primary key over as a unique index, since Lunora mints its own _id", () => {
        expect.assertions(1);

        const schema = emitIntrospection(database, emitOptions).files.find((file) => file.path === "schema.ts");

        expect(schema?.contents).toContain('.index("by_id", ["id"], { unique: true })');
    });

    it("carries secondary indexes over with their uniqueness", () => {
        expect.assertions(1);

        const schema = emitIntrospection(database, emitOptions).files.find((file) => file.path === "schema.ts");

        expect(schema?.contents).toContain('.index("users_email_key", ["email"], { unique: true })');
    });

    it("annotates an unmapped column with a TODO and reports it as a warning", () => {
        expect.assertions(2);

        const result = emitIntrospection(database, emitOptions);
        const schema = result.files.find((file) => file.path === "schema.ts");

        expect(schema?.contents).toContain("// TODO: `geometry` has no direct validator");
        expect(result.warnings.some((warning) => warning.includes("geometry"))).toBe(true);
    });

    it("skips a column that collides with a Lunora system field and says so", () => {
        expect.assertions(2);

        const result = emitIntrospection(
            {
                dialect: "postgres",
                tables: [{ columns: [{ arrayDepth: 0, dataType: "text", name: "_id", nullable: false }], indexes: [], name: "t", primaryKey: [] }],
            },
            emitOptions,
        );

        expect(result.files[0]?.contents).not.toContain("_id: v.string()");
        expect(result.warnings.some((warning) => warning.includes("system column"))).toBe(true);
    });

    it("quotes a column name that isn't a bare JS identifier", () => {
        expect.assertions(1);

        const result = emitIntrospection(
            {
                dialect: "postgres",
                tables: [{ columns: [{ arrayDepth: 0, dataType: "text", name: "user-id", nullable: false }], indexes: [], name: "t", primaryKey: [] }],
            },
            emitOptions,
        );

        expect(result.files[0]?.contents).toContain('"user-id": v.string(),');
    });
});

describe("emitIntrospection — procedure modules", () => {
    it("emits a list/get module per table, built on defineListArgs", () => {
        expect.assertions(3);

        const posts = emitIntrospection(database, emitOptions).files.find((file) => file.path === "posts.ts");

        // Curried on the table's Doc, so a stale column in the scaffold is a
        // compile error rather than a filter that silently never matches.
        expect(posts?.contents).toContain('defineListArgs<Doc<"posts">>()({');
        expect(posts?.contents).toContain("export const list = c.query");
        expect(posts?.contents).toContain("export const get = c.query");
    });

    it("publishes only index-backed columns as filterable", () => {
        expect.assertions(2);

        const users = emitIntrospection(database, emitOptions).files.find((file) => file.path === "users.ts");

        // `id` (primary key) and `email` (indexed) are filterable...
        expect(users?.contents).toContain("email: v.string(),");
        // ...`display_name` has no index, so it is not published as a filter.
        expect(users?.contents).not.toContain("display_name:");
    });

    it("leaves the procedures RPC-only — publishing over REST stays an explicit decision", () => {
        expect.assertions(2);

        const posts = emitIntrospection(database, emitOptions).files.find((file) => file.path === "posts.ts");
        // Only the guidance comment may mention `.expose` — no emitted code calls it.
        const code = (posts?.contents ?? "").split("\n").filter((line) => !["*", "/*", "//"].some((marker) => line.trimStart().startsWith(marker)));

        expect(code.some((line) => line.includes(".expose("))).toBe(false);
        expect(posts?.contents).toContain("Add `.expose({ rest: true })`");
    });

    it("omits procedure modules entirely when procedures are disabled", () => {
        expect.assertions(1);

        const { files } = emitIntrospection(database, { ...emitOptions, procedures: false });

        expect(files.map((file) => file.path)).toEqual(["schema.ts"]);
    });
});

describe("emitIntrospection — hostile catalog identifiers", () => {
    /** A database whose names contain every character that could break out of generated source. */
    const hostile: IntrospectedDatabase = {
        dialect: "postgres",
        tables: [
            {
                columns: [
                    { arrayDepth: 0, dataType: "text", name: 'evil"); process.exit(1); //', nullable: false },
                    { arrayDepth: 0, dataType: "int4", name: "ref", nullable: false, references: { column: "id", table: 'other"' } },
                ],
                indexes: [{ columns: ['evil"); process.exit(1); //'], name: 'idx"', unique: false }],
                name: 'tbl"',
                primaryKey: ['evil"); process.exit(1); //'],
            },
            { columns: [{ arrayDepth: 0, dataType: "text", name: "a", nullable: false }], indexes: [], name: 'other"', primaryKey: [] },
        ],
    };

    /*
     * 60s, not the 30s default. This builds a full TypeScript program per emitted
     * file — three `new Project()` + `getPreEmitDiagnostics()` round trips, which
     * loads the default libs and runs the real checker each time. That is ~290ms
     * on an idle machine and ~1.3s under v8 coverage, but CI's node-22.15 leg runs
     * `test:affected:coverage` over 74 files concurrently, and under that
     * contention it reproducibly blew past 30s while the no-coverage leg
     * (node-24.11) passed. The assertion is unchanged; only the budget is.
     */
    it("emits syntactically valid TypeScript even when every identifier is hostile", () => {
        // schema.ts plus one procedure module per table.
        expect.assertions(3);

        // Substring assertions can't tell `\"` from `"`, so parse instead: the only
        // property that actually matters is that no name can break out of the
        // literal it lands in, and a syntax-error count of zero proves exactly that.
        for (const file of emitIntrospection(hostile, emitOptions).files) {
            const project = new Project({ useInMemoryFileSystem: true });
            const source = project.createSourceFile(file.path, file.contents);

            expect(
                source.getPreEmitDiagnostics().filter((d) => d.getCategory() === DiagnosticCategory.Error && d.getCode() >= 1000 && d.getCode() < 2000),
            ).toEqual([]);
        }
    }, 60_000);

    it("escapes characters that stay dangerous once the emitted file travels", () => {
        expect.assertions(3);

        const result = emitIntrospection(
            {
                dialect: "postgres",
                tables: [
                    {
                        columns: [{ arrayDepth: 0, dataType: "text", name: "a", nullable: false }],
                        indexes: [],
                        // `</script>` would close a host script block if the generated
                        // file is ever inlined into HTML; U+2028 is a line terminator.
                        name: "x</script>y\u2028z",
                        primaryKey: [],
                    },
                ],
            },
            emitOptions,
        );
        const schema = result.files.find((file) => file.path === "schema.ts")?.contents ?? "";

        expect(schema).not.toContain("</script>");
        expect(schema).toContain(String.raw`\u003C`);
        expect(schema).toContain(String.raw`\u2028`);
    });

    it("escapes the payload rather than emitting it raw", () => {
        expect.assertions(2);

        const schema = emitIntrospection(hostile, emitOptions).files.find((file) => file.path === "schema.ts");
        const contents = schema?.contents ?? "";

        // The injected quote is backslash-escaped, and the `//` that would have
        // started a comment is now \u002F-escaped too.
        expect(contents).toContain(String.raw`evil\"); process.exit(1); \u002F\u002F`);
        expect(contents).toContain(String.raw`v.id("other\"")`);
    });

    it("never writes outside the output directory, whatever the table is called", () => {
        expect.assertions(2);

        const result = emitIntrospection(
            {
                dialect: "postgres",
                tables: [
                    { columns: [{ arrayDepth: 0, dataType: "text", name: "a", nullable: false }], indexes: [], name: "../../../etc/passwd", primaryKey: [] },
                ],
            },
            emitOptions,
        );

        expect(result.files.every((file) => !file.path.includes("/") && !file.path.includes(".."))).toBe(true);
        expect(result.warnings.some((warning) => warning.includes("isn't usable as a filename"))).toBe(true);
    });

    it("reports a filename collision instead of silently overwriting one table with another", () => {
        expect.assertions(1);

        const columns = [{ arrayDepth: 0, dataType: "text", name: "a", nullable: false }];
        const result = emitIntrospection(
            {
                dialect: "postgres",
                tables: [
                    { columns, indexes: [], name: "a.b", primaryKey: [] },
                    { columns, indexes: [], name: "a+b", primaryKey: [] },
                ],
            },
            emitOptions,
        );

        expect(result.warnings.some((warning) => warning.includes("collides with table"))).toBe(true);
    });

    it("uses bracket access for a table name that isn't a bare identifier", () => {
        expect.assertions(2);

        const result = emitIntrospection(
            {
                dialect: "postgres",
                tables: [{ columns: [{ arrayDepth: 0, dataType: "text", name: "a", nullable: false }], indexes: [], name: "order-items", primaryKey: [] }],
            },
            emitOptions,
        );
        const procedures = result.files.find((file) => file.path !== "schema.ts")?.contents ?? "";

        // `ctx.db."order-items"` would be a syntax error.
        expect(procedures).toContain('ctx.db["order-items"]');
        expect(procedures).not.toContain('ctx.db."order-items"');
    });
});

describe("emitIntrospection — dialect handling", () => {
    it("maps filter validators with the real dialect, not a hardcoded Postgres", () => {
        expect.assertions(2);

        const mysql: IntrospectedDatabase = {
            dialect: "mysql",
            tables: [
                {
                    columns: [{ arrayDepth: 0, dataType: "datetime", name: "created_at", nullable: false }],
                    indexes: [{ columns: ["created_at"], name: "by_created", unique: false }],
                    name: "events",
                    primaryKey: [],
                },
            ],
        };

        const procedures = emitIntrospection(mysql, emitOptions).files.find((file) => file.path === "events.ts")?.contents ?? "";

        // `datetime` is MySQL-only; under the old hardcoded Postgres map it silently became `v.any()`.
        expect(procedures).toContain("created_at: v.timestamp(),");
        expect(procedures).not.toContain("created_at: v.any(),");
    });
});

describe("emitIntrospection — dangling foreign keys", () => {
    it("demotes an FK whose target is not in the emitted schema, so the output still compiles", () => {
        expect.assertions(3);

        const result = emitIntrospection(
            {
                dialect: "postgres",
                tables: [
                    {
                        columns: [{ arrayDepth: 0, dataType: "int4", name: "author_id", nullable: false, references: { column: "id", table: "users" } }],
                        indexes: [],
                        name: "posts",
                        primaryKey: [],
                    },
                ],
            },
            emitOptions,
        );
        const schema = result.files.find((file) => file.path === "schema.ts")?.contents ?? "";

        // `users` was filtered out by --tables, so `v.id("users")` would not resolve.
        expect(schema).not.toContain('v.id("users")');
        expect(schema).toContain("author_id: v.number(),");
        expect(result.warnings.some((warning) => warning.includes("isn't in the generated schema"))).toBe(true);
    });
});

describe("identifierFor", () => {
    it("camelCases a snake_case table name into a usable const name", () => {
        expect.assertions(3);

        expect(identifierFor("order_items")).toBe("orderItems");
        expect(identifierFor("users")).toBe("users");
        expect(identifierFor("2fa_tokens")).toBe("faTokens");
    });
});

describe("indexedColumns", () => {
    it("includes primary-key, indexed, and foreign-key columns", () => {
        expect.assertions(2);

        expect(indexedColumns(usersTable).toSorted((a, b) => a.localeCompare(b))).toEqual(["email", "id"]);
        expect(indexedColumns(postsTable).toSorted((a, b) => a.localeCompare(b))).toEqual(["author_id", "id"]);
    });
});

describe("resolveType", () => {
    it("unwraps a Postgres array into its element type plus a depth", () => {
        expect.assertions(1);

        expect(resolveType({ data_type: "ARRAY", udt_name: "_text" }, "postgres")).toEqual({ arrayDepth: 1, dataType: "text" });
    });

    it("prefers the specific udt_name spelling over the generic data_type", () => {
        expect.assertions(1);

        expect(resolveType({ data_type: "integer", udt_name: "int4" }, "postgres")).toEqual({ arrayDepth: 0, dataType: "int4" });
    });

    it("uses data_type directly for MySQL, which has no array types", () => {
        expect.assertions(1);

        expect(resolveType({ DATA_TYPE: "VARCHAR" }, "mysql")).toEqual({ arrayDepth: 0, dataType: "varchar" });
    });
});

describe("readDatabase", () => {
    /** Fake executor that answers each of the four introspection queries by matching on a distinctive fragment. */
    const executor: SqlExecutor = vi.fn<SqlExecutor>(async (sql: string) => {
        if (sql.includes("information_schema.columns")) {
            return [
                { column_name: "id", data_type: "integer", is_nullable: "NO", table_name: "users", udt_name: "int4" },
                { column_name: "email", data_type: "text", is_nullable: "NO", table_name: "users", udt_name: "text" },
                { column_name: "author_id", data_type: "integer", is_nullable: "NO", table_name: "posts", udt_name: "int4" },
            ];
        }

        if (sql.includes("PRIMARY KEY")) {
            return [{ column_name: "id", table_name: "users" }];
        }

        if (sql.includes("FOREIGN KEY")) {
            return [{ column_name: "author_id", foreign_column: "id", foreign_table: "users", table_name: "posts" }];
        }

        return [
            { column_name: "email", index_name: "users_email_key", is_unique: "true", table_name: "users" },
            { column_name: "a", index_name: "posts_ab", is_unique: "false", table_name: "posts" },
            { column_name: "b", index_name: "posts_ab", is_unique: "false", table_name: "posts" },
        ];
    });

    it("folds the four queries into one dialect-neutral model, sorted by table name", async () => {
        expect.assertions(4);

        const result = await readDatabase(executor, "postgres", "public");

        expect(result.tables.map((table) => table.name)).toEqual(["posts", "users"]);
        expect(result.tables.find((table) => table.name === "users")?.primaryKey).toEqual(["id"]);
        expect(result.tables.find((table) => table.name === "posts")?.columns[0]?.references).toEqual({ column: "id", table: "users" });
        // A composite index keeps its column order.
        expect(result.tables.find((table) => table.name === "posts")?.indexes).toEqual([{ columns: ["a", "b"], name: "posts_ab", unique: false }]);
    });

    it("never issues a write — every query is a read against information_schema/pg_catalog", async () => {
        expect.assertions(1);

        const seen: string[] = [];

        await readDatabase(
            async (sql) => {
                seen.push(sql);

                return [];
            },
            "postgres",
            "public",
        );

        expect(seen.every((sql) => /^\s*SELECT/i.test(sql))).toBe(true);
    });
});

describe("dialectFromUrl", () => {
    it("infers the dialect from the connection-string scheme", () => {
        expect.assertions(4);

        expect(dialectFromUrl("postgres://localhost/shop")).toBe("postgres");
        expect(dialectFromUrl("postgresql://localhost/shop")).toBe("postgres");
        expect(dialectFromUrl("mysql://localhost/shop")).toBe("mysql");
        expect(dialectFromUrl("mariadb://localhost/shop")).toBe("mysql");
    });

    it("rejects an unrecognised scheme with an actionable message", () => {
        expect.assertions(1);

        expect(() => dialectFromUrl("mongodb://localhost/shop")).toThrow(/Unrecognised database URL scheme/);
    });
});

describe("loadDriver", () => {
    let projectRoot: string;

    afterEach(() => {
        rmSync(projectRoot, { force: true, recursive: true });
    });

    it("names the detected manager's own add-dependency command, not a hardcoded pnpm", () => {
        expect.assertions(1);

        projectRoot = mkdtempSync(join(tmpdir(), "lunora-introspect-driver-"));
        // `packageManager` is the strongest of `detectPackageManager`'s
        // signals — deterministic regardless of what happens to be on PATH.
        writeFileSync(join(projectRoot, "package.json"), JSON.stringify({ packageManager: "yarn@4.0.0" }), "utf8");

        expect(() => loadDriver("this-module-does-not-exist", "pg", projectRoot)).toThrow("yarn add -D pg");
    });

    // The "detection itself fails" branch (falls back to the
    // `<your-package-manager> add -D …` placeholder) isn't reachable from this
    // suite: `detectPackageManager`'s last resort is "first manager installed
    // on PATH", and this repo's own sandbox always has pnpm on PATH — see
    // `detect-package-manager.test.ts`'s equivalent note. Covered at the
    // `formatUpdateNotice` unit level instead (`update-notifier.test.ts`).
});
