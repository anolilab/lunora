import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { diffSchemaSnapshots } from "../../../shared/schema-snapshot";
import discoverSchema from "../src/discover/schema";
import { buildSchemaSnapshot } from "../src/schema-drift";

/**
 * The `presence` registry item's table, as codegen sees it in an app that
 * extends its schema with it, compared against the shape installs carry from
 * before rooms were tenant-scoped.
 *
 * Codegen — not the runtime schema — decides what the deploy's drift gate sees,
 * so the item is discovered from its source text exactly as an app's `lunora/`
 * directory would hold it.
 */

const here = dirname(fileURLToPath(import.meta.url));
// __tests__ → packages/codegen → packages → repo root → registry/presence
const itemSchema = readFileSync(resolve(here, "..", "..", "..", "registry", "presence", "schema.ts"), "utf8");

const APP_SCHEMA = `
    import { defineSchema, defineTable, v } from "@lunora/server";

    import { presence } from "./presence/schema";

    export const schema = defineSchema({ rooms: defineTable({ name: v.string() }) }).extend(presence.extension);
`;

/** The item's table before rooms were tenant-scoped: what an existing install's baseline holds. */
const UNTENANTED_ITEM_SCHEMA = `
    import { definePlugin, defineSchemaExtension, defineTable, v } from "@lunora/server";

    export const presence = definePlugin("presence", {
        extension: defineSchemaExtension("presence", {
            tables: {
                present: defineTable({
                    data: v.optional(v.record(v.string(), v.any())),
                    lastSeen: v.number(),
                    roomId: v.string(),
                    sessionId: v.string(),
                    userId: v.optional(v.string()),
                }).index("byRoomSession", ["roomId", "sessionId"]),
            },
        }),
    });
`;

const snapshotOf = (presenceSchema: string): ReturnType<typeof buildSchemaSnapshot> => {
    const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });

    project.createSourceFile("/virtual/lunora/presence/schema.ts", presenceSchema);
    project.createSourceFile("/virtual/lunora/schema.ts", APP_SCHEMA);

    return buildSchemaSnapshot(discoverSchema(project, "/virtual/lunora/schema.ts"), []);
};

describe("presence registry item — schema drift on upgrade", () => {
    it("adds tenantId as an optional column, so rows written before it stay valid", () => {
        expect.assertions(2);

        const { changes } = diffSchemaSnapshots(snapshotOf(UNTENANTED_ITEM_SCHEMA), snapshotOf(itemSchema));

        expect(changes).toContainEqual(expect.objectContaining({ severity: "safe", type: "addedOptionalField" }));
        expect(changes.filter((change) => change.type === "addedRequiredField")).toStrictEqual([]);
    });
});
