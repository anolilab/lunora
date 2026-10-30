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

    it("expires rows through the table TTL every shard's alarm runs, at the read-time cutoff", () => {
        expect.assertions(1);

        // `sweep` runs on whichever shard dispatches it, and a cron only reaches the
        // root one; an organization's rooms live in its own shard. The alarm sweep
        // codegen derives from `.ttl()` is what runs in each of them.
        const ttlMs = Number(/PRESENCE_TTL_MS = ([\d_]+);/u.exec(itemSchema)?.[1]?.replaceAll("_", ""));

        expect(snapshotOf(itemSchema).tables["presence_present"]?.ttl).toStrictEqual({ after: ttlMs, field: "lastSeen" });
    });

    it("declares no lastSeen index of its own, since the engine already keeps one for the TTL", () => {
        expect.assertions(1);

        // Every heartbeat rewrites `lastSeen`, so a declared copy of the TTL's
        // expression index would double the index writes on the hottest path.
        const indexes = Object.values(snapshotOf(itemSchema).tables["presence_present"]?.indexes ?? {});

        expect(indexes.filter(({ fields }) => fields[0] === "lastSeen")).toStrictEqual([]);
    });
});
