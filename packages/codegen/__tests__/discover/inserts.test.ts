import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverInserts from "../../src/discover/inserts";
import { markerLine, scopeName } from "../call-site-fixture";

const MESSAGES = `
    import { mutation, query } from "@lunora/server";

    const dynamicTable = "messages";

    // Conventional name.
    export const send = mutation({ args: {}, handler: async (ctx) => ctx.db.insert("messages", { text: "x" }) });

    // Non-conventional name + the insert is assigned to a local const — still
    // attributed to the exported function.
    export const post = mutation({
        args: {},
        handler: async (ctx) => {
            const id = ctx.db.insert("messages", { text: "y" });
            return id;
        },
    });

    // A read — not an insert.
    export const list = query({ args: {}, handler: (ctx) => ctx.db.query("messages").collect() });

    // String-const table name — resolved to its literal value ("messages").
    export const aliased = mutation({ args: {}, handler: (ctx) => ctx.db.insert(dynamicTable, {}) });

    // Genuinely dynamic (computed) table — not resolvable, discovered with table "".
    export const dynamic = mutation({ args: {}, handler: (ctx) => ctx.db.insert(\`tbl_\${ctx.foo}\`, {}) });

    // Not exported and never referenced — kept, scoped to the helper with no callers.
    const helper = (ctx) => ctx.db.insert("secret", {}); // @secret

    // A helper two exports call, reached through a second helper and a cycle.
    function audit(ctx) {
        return ctx.db.insert("audit", {}); // @audit
    }
    const record = (ctx) => (ctx.retry ? retry(ctx) : audit(ctx));
    const retry = (ctx) => record(ctx);

    export const archive = mutation({ args: {}, handler: (ctx) => record(ctx) });
    export async function legacy(ctx) {
        return audit(ctx);
    }
`;

const CHANNELS = `
    import { mutation } from "@lunora/server";

    export const create = mutation({ args: {}, handler: (ctx) => ctx.db.insert("channels", { name: "general" }) });
`;

let workdir: string;
let project: Project;

describe("discoverInserts", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-inserts-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "lunora", "messages.ts"), MESSAGES, "utf8");
        writeFileSync(join(workdir, "lunora", "channels.ts"), CHANNELS, "utf8");
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("attributes each insert to its exported function and file", () => {
        expect.assertions(3);

        const writes = discoverInserts(project, join(workdir, "lunora")).map(({ file, scope, table }) => {
            return { file, scope, table };
        });

        // Conventional + non-conventional + assigned-to-const all attribute correctly.
        expect(writes).toContainEqual({ file: "messages", scope: { kind: "export", name: "send" }, table: "messages" });
        expect(writes).toContainEqual({ file: "messages", scope: { kind: "export", name: "post" }, table: "messages" });
        expect(writes).toContainEqual({ file: "channels", scope: { kind: "export", name: "create" }, table: "channels" });
    });

    it("resolves a string-const table argument to its literal value", () => {
        expect.assertions(1);

        // `ctx.db.insert(dynamicTable, …)` where `const dynamicTable = "messages"`
        // — the const is resolved so the write attributes to the real table (this
        // is what stops `table_without_insert` false-flagging const-aliased tables).
        const aliased = discoverInserts(project, join(workdir, "lunora")).find((write) => scopeName(write.scope) === "aliased");

        expect(aliased).toMatchObject({ table: "messages" });
    });

    it("records a genuinely dynamic (computed) table argument as an empty table", () => {
        expect.assertions(1);

        const dynamic = discoverInserts(project, join(workdir, "lunora")).find((write) => scopeName(write.scope) === "dynamic");

        expect(dynamic).toMatchObject({ table: "" });
    });

    it("keeps an insert in a helper no export calls, scoped to the helper with no callers", () => {
        expect.assertions(1);

        const writes = discoverInserts(project, join(workdir, "lunora")).filter((write) => write.table === "secret");

        expect(writes).toStrictEqual([
            { file: "messages", line: markerLine(MESSAGES, "secret"), scope: { callers: [], kind: "helper", name: "helper" }, table: "secret" },
        ]);
    });

    it("records an insert in a helper once, carrying every export reaching it transitively and through a cycle", () => {
        expect.assertions(1);

        const writes = discoverInserts(project, join(workdir, "lunora")).filter((write) => write.table === "audit");

        // One record per site; an exported function declaration counts as an export.
        expect(writes).toStrictEqual([
            { file: "messages", line: markerLine(MESSAGES, "audit"), scope: { callers: ["archive", "legacy"], kind: "helper", name: "audit" }, table: "audit" },
        ]);
    });
});
