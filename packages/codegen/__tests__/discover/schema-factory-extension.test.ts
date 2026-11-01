import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverSchema from "../../src/discover/schema";

let root: string;

/**
 * A fake installed package whose factory builds a component, the way
 * `definePresence` does. Its extension key comes from the factory's argument, so
 * a resolved table proves the literal options reached the call.
 */
const installFactoryPackage = (): void => {
    const packageDirectory = join(root, "node_modules", "test-component");

    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(
        join(packageDirectory, "package.json"),
        JSON.stringify({ exports: "./index.mjs", main: "index.mjs", name: "test-component", type: "module" }),
    );
    writeFileSync(
        join(packageDirectory, "index.mjs"),
        `const s = (kind) => ({ kind, _meta: { column: { notNull: true } } });
         export const defineThing = (options = {}) => {
             const key = options.key ?? "thing";
             return { extension: { key, tables: { items: { shape: { name: s("string") }, indexes: [], shardMode: { kind: "root" } } } }, functions: {} };
         };
        `,
    );
};

const tableNames = (files: Record<string, string>): string[] => {
    mkdirSync(join(root, "lunora"), { recursive: true });

    for (const [name, source] of Object.entries(files)) {
        writeFileSync(join(root, "lunora", name), source);
    }

    const schema = discoverSchema(new Project({ skipAddingFilesFromTsConfig: true }), join(root, "lunora", "schema.ts"), root);

    return schema.tables.map((table) => table.name).toSorted((a, b) => a.localeCompare(b));
};

describe("discoverSchema — .extend(component.extension) over a package factory", () => {
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-factory-ext-"));
        installFactoryPackage();
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("resolves a component built in another module and imported into the schema", () => {
        expect.assertions(1);

        expect(
            tableNames({
                "schema.ts": `import { defineSchema, defineTable, v } from "@lunora/server";
import { thing } from "./thing";
export default defineSchema({ todos: defineTable({ title: v.string() }) }).extend(thing.extension);
`,
                "thing.ts": `import { defineThing } from "test-component";
export const thing = defineThing({ key: "collab", limits: [1, -2], note: null });
`,
            }),
        ).toStrictEqual(["collab_items", "todos"]);
    });

    it("resolves a component built in the schema module itself", () => {
        expect.assertions(1);

        expect(
            tableNames({
                "schema.ts": `import { defineSchema, defineTable, v } from "@lunora/server";
import { defineThing } from "test-component";
const thing = defineThing();
export default defineSchema({ todos: defineTable({ title: v.string() }) }).extend(thing.extension);
`,
            }),
        ).toStrictEqual(["thing_items", "todos"]);
    });

    it("does not call a factory whose options are not literals", () => {
        expect.assertions(1);

        expect(
            tableNames({
                "schema.ts": `import { defineSchema, defineTable, v } from "@lunora/server";
import { defineThing } from "test-component";
const tenant = (identity: unknown) => String(identity);
const thing = defineThing({ key: "collab", tenant });
export default defineSchema({ todos: defineTable({ title: v.string() }) }).extend(thing.extension);
`,
            }),
        ).toStrictEqual(["todos"]);
    });
});
