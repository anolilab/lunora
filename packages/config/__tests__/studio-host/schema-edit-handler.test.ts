import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleSchemaEditRequest } from "../../src/studio-host/schema-edit-handler";

const SCHEMA = `import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    todos: defineTable({
        text: v.string(),
        done: v.boolean(),
    }).index("by_text", ["text"]),
});
`;

describe("handleSchemaEditRequest", () => {
    let projectRoot: string;
    let schemaPath: string;

    const writeSchema = (source: string): void => {
        mkdirSync(join(projectRoot, "lunora"), { recursive: true });
        writeFileSync(schemaPath, source, "utf8");
    };

    beforeEach(() => {
        projectRoot = mkdtempSync(join(tmpdir(), "lunora-schema-edit-"));
        schemaPath = join(projectRoot, "lunora", "schema.ts");
    });

    afterEach(() => {
        rmSync(projectRoot, { force: true, recursive: true });
    });

    it("returns the parsed schema tables on GET", () => {
        expect.assertions(2);

        writeSchema(SCHEMA);

        const result = handleSchemaEditRequest({ method: "GET", projectRoot });
        const body = result.body as { ok: boolean; tables: ReadonlyArray<{ name: string }> };

        expect(result.status).toBe(200);
        expect(body.tables.map((table) => table.name)).toStrictEqual(["todos"]);
    });

    it("returns 404 on GET when there is no schema file", () => {
        expect.assertions(1);

        expect(handleSchemaEditRequest({ method: "GET", projectRoot }).status).toBe(404);
    });

    it("applies an additive edit on POST, writes the file, and returns the new schema", () => {
        expect.assertions(3);

        writeSchema(SCHEMA);

        const result = handleSchemaEditRequest({
            body: { column: "due", kind: "addOptionalColumn", table: "todos", validator: "v.number()" },
            method: "POST",
            projectRoot,
        });
        const body = result.body as { ok: boolean; tables: ReadonlyArray<{ columns: ReadonlyArray<{ name: string }>; name: string }> };

        expect(result.status).toBe(200);
        // The on-disk source was rewritten with the new column.
        expect(readFileSync(schemaPath, "utf8")).toContain("v.optional(v.number())");
        // The returned schema reflects the new column.
        expect(body.tables.find((table) => table.name === "todos")?.columns.some((column) => column.name === "due")).toBe(true);
    });

    it("regenerates with the host's apiSpec instead of the default", () => {
        expect.assertions(2);

        writeSchema(SCHEMA);

        // Codegen writes the spec its mode names and REMOVES the other, so an edit
        // that defaulted to "openapi" deleted the `openrpc.json` an
        // `apiSpec: "openrpc"` project had just generated — and the next watcher
        // run put it back, once per edit.
        const result = handleSchemaEditRequest({
            apiSpec: "openrpc",
            body: { column: "due", kind: "addOptionalColumn", table: "todos", validator: "v.number()" },
            method: "POST",
            projectRoot,
        });

        expect(result.status).toBe(200);
        expect(existsSync(join(projectRoot, "lunora", "_generated", "openrpc.json"))).toBe(true);
    });

    it("writes the source but skips codegen when the codegen switch is off", () => {
        expect.assertions(3);

        writeSchema(SCHEMA);

        // `lunora dev --no-codegen` travels as LUNORA_CODEGEN=0 and promises that
        // `_generated/` is written only by an explicit `lunora codegen`. The studio
        // endpoints regenerate in-process, so without reading the switch one "add
        // column" rewrote the whole generated tree the flag had just excluded.
        process.env.LUNORA_CODEGEN = "0";

        try {
            const result = handleSchemaEditRequest({
                body: { column: "due", kind: "addOptionalColumn", table: "todos", validator: "v.number()" },
                method: "POST",
                projectRoot,
            });

            expect(result.status).toBe(200);
            expect(readFileSync(schemaPath, "utf8")).toContain("v.optional(v.number())");
            expect(existsSync(join(projectRoot, "lunora", "_generated"))).toBe(false);
        } finally {
            delete process.env.LUNORA_CODEGEN;
        }
    });

    it("returns 409 needsMigration on a destructive POST and does NOT write the file", () => {
        expect.assertions(3);

        writeSchema(SCHEMA);
        const before = readFileSync(schemaPath, "utf8");

        const result = handleSchemaEditRequest({
            body: { column: "text", kind: "dropColumn", table: "todos" },
            method: "POST",
            projectRoot,
        });
        const body = result.body as { needsMigration?: boolean };

        expect(result.status).toBe(409);
        expect(body.needsMigration).toBe(true);
        // The source is untouched — destructive edits route to the migration handoff.
        expect(readFileSync(schemaPath, "utf8")).toBe(before);
    });

    it("rejects a POST body without a kind", () => {
        expect.assertions(1);

        writeSchema(SCHEMA);

        expect(handleSchemaEditRequest({ body: { table: "todos" }, method: "POST", projectRoot }).status).toBe(400);
    });

    it("reports a duplicate table without touching the source", () => {
        expect.assertions(2);

        writeSchema(SCHEMA);
        const before = readFileSync(schemaPath, "utf8");

        const result = handleSchemaEditRequest({ body: { kind: "addTable", table: "todos" }, method: "POST", projectRoot });

        expect(result.status).toBe(409);
        expect(readFileSync(schemaPath, "utf8")).toBe(before);
    });

    it("reports an aliased define-schema as unsupported (422)", () => {
        expect.assertions(2);

        writeSchema(`import { defineSchema as ds, defineTable, v } from "@lunora/server";\nexport default ds({ a: defineTable({ x: v.string() }) });\n`);
        const before = readFileSync(schemaPath, "utf8");

        const result = handleSchemaEditRequest({ body: { kind: "addTable", table: "b" }, method: "POST", projectRoot });

        expect(result.status).toBe(422);
        expect(readFileSync(schemaPath, "utf8")).toBe(before);
    });

    it("rejects a POST body of literal null with a 400 (not a 500 TypeError)", () => {
        expect.assertions(2);

        writeSchema(SCHEMA);

        // `typeof null === "object"`, so a naive guard dereferences null and 500s.
        const result = handleSchemaEditRequest({ body: null, method: "POST", projectRoot });

        expect(result.status).toBe(400);
        expect(result.body).toStrictEqual({ error: "invalid-edit", ok: false });
    });

    it("rejects an unsupported HTTP method", () => {
        expect.assertions(1);

        expect(handleSchemaEditRequest({ method: "DELETE", projectRoot }).status).toBe(405);
    });
});
