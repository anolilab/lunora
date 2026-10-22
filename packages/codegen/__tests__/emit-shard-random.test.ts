import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import discoverSchema from "../src/discover/schema";
import { emitShard } from "../src/emit";

/**
 * `ctx.random()` is derived from the same replay key and scope as `ctx.newId()`,
 * so a replay of a keyed mutation reproduces both. The emitter computes the key
 * and the scope once; a second computation could drift from the first.
 */

const discover = (source: string) => {
    const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    const schemaPath = "/virtual/lunora/schema.ts";

    project.createSourceFile(schemaPath, source);

    return discoverSchema(project, schemaPath);
};

const PLAIN = `
    import { defineSchema, defineTable, v } from "@lunora/server";

    export const schema = defineSchema({
        documents: defineTable({ title: v.string() }).shardBy("title"),
    });
`;

describe("emitShard — ctx.random", () => {
    it("builds ctx.random from the same replay key and scope as ctx.newId", () => {
        expect.assertions(3);

        const shard = emitShard({ schema: discover(PLAIN) });

        expect(shard).toContain("newId: createStableIdFactory(stableKey, stableScope),");
        expect(shard).toContain('random: createStableRandomFactory(contextKind === "mutation" ? stableKey : undefined, stableScope),');
        expect(shard).toContain("createStableRandomFactory, ");
    });

    it("gives a composed query an unseeded ctx.random", () => {
        expect.assertions(1);

        const shard = emitShard({ schema: discover(PLAIN) });

        expect(shard).toContain("random: field(createStableRandomFactory(undefined, stableScope)),");
    });

    it("gives a mutation composed from an action the action's replay key", () => {
        expect.assertions(1);

        const shard = emitShard({ schema: discover(PLAIN) });

        expect(shard).toContain("value: createStableRandomFactory(stableKey, stableScope), writable: true },");
    });

    it("keeps a reactor run off the writer's replay key", () => {
        expect.assertions(1);

        const shard = emitShard({ schema: discover(PLAIN) });

        expect(shard).toContain(
            "functionPath, headroom: this.subscriptionHeadroom(), onRead: footprint.onRead, onReadRange: footprint.onReadRange, replayKey: false, trusted: true });",
        );
    });
});
