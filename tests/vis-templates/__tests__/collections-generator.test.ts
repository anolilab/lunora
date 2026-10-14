import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import collectionsTemplate from "../../../.vis/templates/lunora-collections.js";

let workdir: string;

const write = (relative: string, source: string): void => {
    const path = join(workdir, "lunora", relative);

    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, source, "utf8");
};

/** Run the generator over the scaffolded `lunora/` and return the `collections.ts` it writes. */
const generate = async (): Promise<string> => {
    const creation = await collectionsTemplate.produce({
        builtins: { dest_dir: workdir, dest_rel_dir: ".", working_dir: workdir, workspace_root: workdir },
        options: {},
    });
    const file = (creation.files?.["lunora"] as Record<string, unknown> | undefined)?.["collections.ts"];

    if (typeof file !== "string") {
        throw new TypeError("lunora-collections did not produce lunora/collections.ts");
    }

    return file;
};

const SCHEMA = `import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({
    messages: defineTable({ text: v.string() }),
    notes: defineTable({ body: v.string() }),
    logs: defineTable({ line: v.string() }),
});
`;

describe("lunora-collections attributes each table's insert mutation", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-collections-"));
        write("schema.ts", SCHEMA);
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    test("an insert inside a helper names the exported mutation calling it; dead code names none", async () => {
        expect.assertions(4);

        write(
            "messages.ts",
            `import { mutation } from "./_generated/server.js";
const persist = (ctx, text) => ctx.db.insert("messages", { text });
export const send = mutation({ handler: async (ctx, args) => persist(ctx, args.text) });
`,
        );
        write(
            "notes.ts",
            `import { mutation } from "./_generated/server.js";
export const add = mutation({ handler: async (ctx, args) => ctx.db.insert("notes", { body: args.body }) });
`,
        );
        write("logs.ts", `const orphan = (ctx) => ctx.db.insert("logs", { line: "x" });\n`);

        const file = await generate();

        // Through a helper: wired to the export that calls it, not to the helper.
        expect(file).toContain("messages.send inserts into messages");
        expect(file).toContain("notes.add inserts into notes");
        expect(file).not.toContain("persist");
        // A helper no export calls has no mutation to wire.
        expect(file).not.toContain("inserts into logs");
    });
});
