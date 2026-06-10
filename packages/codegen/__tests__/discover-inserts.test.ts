import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverInserts from "../src/discover-inserts";

const MESSAGES = `
    import { mutation, query } from "@cirrus/server";

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

    // Dynamic (non-literal) table — discovered but with table "".
    export const dynamic = mutation({ args: {}, handler: (ctx) => ctx.db.insert(dynamicTable, {}) });

    // Not exported — dropped.
    const helper = (ctx) => ctx.db.insert("secret", {});
`;

const CHANNELS = `
    import { mutation } from "@cirrus/server";

    export const create = mutation({ args: {}, handler: (ctx) => ctx.db.insert("channels", { name: "general" }) });
`;

let workdir: string;
let project: Project;

describe("discoverInserts", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-inserts-"));
        mkdirSync(join(workdir, "cirrus"), { recursive: true });
        writeFileSync(join(workdir, "cirrus", "messages.ts"), MESSAGES, "utf8");
        writeFileSync(join(workdir, "cirrus", "channels.ts"), CHANNELS, "utf8");
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("attributes each insert to its exported function and file", () => {
        expect.assertions(3);

        const writes = discoverInserts(project, join(workdir, "cirrus")).map(({ exportName, file, table }) => {
            return { exportName, file, table };
        });

        // Conventional + non-conventional + assigned-to-const all attribute correctly.
        expect(writes).toContainEqual({ exportName: "send", file: "messages", table: "messages" });
        expect(writes).toContainEqual({ exportName: "post", file: "messages", table: "messages" });
        expect(writes).toContainEqual({ exportName: "create", file: "channels", table: "channels" });
    });

    it("records a non-literal table argument as an empty table", () => {
        expect.assertions(1);

        const dynamic = discoverInserts(project, join(workdir, "cirrus")).find((write) => write.exportName === "dynamic");

        expect(dynamic).toMatchObject({ table: "" });
    });

    it("drops inserts that aren't inside an exported declaration", () => {
        expect.assertions(1);

        const writes = discoverInserts(project, join(workdir, "cirrus"));

        expect(writes.some((write) => write.table === "secret")).toBe(false);
    });
});
