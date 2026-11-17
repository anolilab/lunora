import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import discoverSchema from "../src/discover/schema";
import { emitShard } from "../src/emit";

/**
 * `ctx.shardKey` is the shard the dispatch runs on, read from the Durable Object
 * that is serving it — never from anything the caller sends with the arguments.
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

describe("emitShard — ctx.shardKey", () => {
    it("reads the key from the serving shard", () => {
        expect.assertions(1);

        const shard = emitShard({ schema: discover(PLAIN) });

        expect(shard).toContain("shardKey: this.currentShardKey(),");
    });

    it("carries it into a composed query and mutation, which copy the caller's context", () => {
        expect.assertions(2);

        const shard = emitShard({ schema: discover(PLAIN) });

        // Neither view overrides `shardKey`, so the copied descriptor is the caller's own.
        expect(shard).toContain("...Object.getOwnPropertyDescriptors(target),");
        expect(shard).not.toMatch(/shardKey: (?:field\(|\{ configurable)/u);
    });
});
