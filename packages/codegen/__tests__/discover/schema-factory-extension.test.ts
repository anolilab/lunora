import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
        JSON.stringify({
            exports: { ".": { import: "./index.mjs", types: "./index.d.ts" } },
            main: "index.mjs",
            name: "test-component",
            type: "module",
            types: "index.d.ts",
        }),
    );
    writeFileSync(
        join(packageDirectory, "index.d.ts"),
        `export declare const defineThing: (options?: Record<string, unknown>) => {
    extension: { key: string; tables: Record<string, unknown> };
    functions: Record<string, never>;
};
export declare const track: (options?: Record<string, unknown>) => { extension: string };
export declare const defineRich: typeof defineThing;
declare const defineDefault: typeof defineThing;
export default defineDefault;
`,
    );
    writeFileSync(
        join(packageDirectory, "index.mjs"),
        `const s = (kind) => ({ kind, _meta: { column: { notNull: true } } });
         import { writeFileSync } from "node:fs";
         export const track = (options = {}) => {
             writeFileSync(options.marker, "called");
             return { extension: { key: "tracked", tables: { items: { shape: { name: s("string") }, indexes: [], shardMode: { kind: "root" } } } } };
         };
         export default (options = {}) => defineThing({ key: "byDefault", ...options });
         export const defineRich = () => ({
             extension: {
                 key: "rich",
                 tables: {
                     spots: {
                         shape: { expiresAt: s("number"), loc: s("geoPoint") },
                         indexes: [],
                         geoIndexes: [{ field: "loc", name: "byLoc", precision: 6 }],
                         ttlPolicy: { field: "expiresAt", after: 1000 },
                         shardMode: { kind: "global", backend: "hyperdrive" },
                     },
                     scratch: { shape: { note: s("string") }, indexes: [], memoryMode: true, shardMode: { kind: "root" } },
                     events: {
                         shape: { deletedAt: s("number"), expiresAt: s("number") },
                         indexes: [],
                         aggregateIndexes: [{ name: "byCount" }],
                         commitOrderedMode: true,
                         isPublic: true,
                         softDeleteMode: { field: "deletedAt" },
                         ttlPolicy: { field: "expiresAt" },
                         shardMode: { kind: "root" },
                     },
                 },
             },
         });
         export const defineThing = (options = {}) => {
             const key = options.key ?? "thing";
             return { extension: { key, tables: { items: { shape: { name: s("string") }, indexes: [], shardMode: { kind: "root" } } } }, functions: {} };
         };
        `,
    );
};

const tables = (files: Record<string, string>) => {
    mkdirSync(join(root, "lunora"), { recursive: true });

    for (const [name, source] of Object.entries(files)) {
        writeFileSync(join(root, "lunora", name), source);
    }

    return discoverSchema(new Project({ skipAddingFilesFromTsConfig: true }), join(root, "lunora", "schema.ts"), root).tables;
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

    it("never calls a package export whose declared type is not a component factory", () => {
        expect.assertions(2);

        const marker = join(root, "called.txt");

        expect(
            tableNames({
                "schema.ts": `import { defineSchema, defineTable, v } from "@lunora/server";
import { track } from "test-component";
const thing = track({ marker: ${JSON.stringify(marker)} });
export default defineSchema({ todos: defineTable({ title: v.string() }) }).extend(thing.extension);
`,
            }),
        ).toStrictEqual(["todos"]);
        expect(existsSync(marker)).toBe(false);
    });

    it("does not copy options whose literal sets a prototype", () => {
        expect.assertions(1);

        expect(
            tableNames({
                "schema.ts": `import { defineSchema, defineTable, v } from "@lunora/server";
import { defineThing } from "test-component";
const thing = defineThing({ __proto__: { key: "inherited" } });
export default defineSchema({ todos: defineTable({ title: v.string() }) }).extend(thing.extension);
`,
            }),
        ).toStrictEqual(["todos"]);
    });

    it.each([
        ["a default import", `import defineThing from "test-component";\nconst thing = defineThing();`, "byDefault_items"],
        ["a namespace import", `import * as components from "test-component";\nconst thing = components.defineThing({ key: "spaced" });`, "spaced_items"],
    ])("resolves a factory reached through %s", (_form, binding, table) => {
        expect.assertions(1);

        expect(
            tableNames({
                "schema.ts": `import { defineSchema, defineTable, v } from "@lunora/server";
${binding}
export default defineSchema({ todos: defineTable({ title: v.string() }) }).extend(thing.extension);
`,
            }),
        ).toStrictEqual([table, "todos"]);
    });

    it("keeps a factory table's declarations: expiry, indexes, backend, memory, soft delete, visibility", () => {
        expect.assertions(3);

        const discovered = tables({
            "schema.ts": `import { defineSchema, defineTable, v } from "@lunora/server";
import { defineRich } from "test-component";
const rich = defineRich();
export default defineSchema({ todos: defineTable({ title: v.string() }) }).extend(rich.extension);
`,
        });
        const spots = discovered.find((table) => table.name === "rich_spots");

        // `.memory()` rows are cleared on wake; dropping the flag would keep them.
        expect(discovered.find((table) => table.name === "rich_scratch")?.memory).toBe(true);
        expect(discovered.find((table) => table.name === "rich_events")).toMatchObject({
            aggregateIndexed: true,
            commitOrdered: true,
            isPublic: true,
            softDelete: { field: "deletedAt" },
            ttl: { field: "expiresAt" },
        });
        expect(spots).toMatchObject({
            geoIndexes: [{ field: "loc", name: "byLoc", precision: 6 }],
            globalBackend: "hyperdrive",
            shardMode: "global",
            ttl: { after: 1000, field: "expiresAt" },
        });
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
