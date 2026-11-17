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

        expect(shard).toContain(
            'newId: contextKind === "query" ? createStableIdFactory(undefined, "") : scoped((scope) => createStableIdFactory(stableKey, scope)),',
        );
        expect(shard).toContain(
            'random: contextKind === "mutation" ? scoped((scope) => createStableRandomFactory(stableKey, scope)) : createStableRandomFactory(undefined, ""),',
        );
        expect(shard).toContain("createStableRandomFactory, ");
    });

    it("gives a composed query an unseeded ctx.random", () => {
        expect.assertions(1);

        const shard = emitShard({ schema: discover(PLAIN) });

        expect(shard).toContain("random: field(scoped((scope) => createStableRandomFactory(undefined, scope))),");
    });

    it("draws every mutation an action composes from one shared sequence", () => {
        expect.assertions(3);

        const shard = emitShard({ schema: discover(PLAIN) });

        // Created once, on the first composed mutation, and reused by every later one.
        expect(shard).toContain("let composedRandom: (() => number) | undefined;");
        expect(shard).toContain("const mutationRandom = (composedRandom ??= scoped((scope) => createStableRandomFactory(stableKey, scope)));");
        expect(shard).toContain("random: { configurable: true, enumerable: true, value: mutationRandom, writable: true },");
    });

    it("serialises the scope only when there is a replay key to scope, and reads the caller on the first draw", () => {
        expect.assertions(1);

        const shard = emitShard({ schema: discover(PLAIN) });

        expect(shard).toContain("const scopeHead = stableKey === undefined ? [] : [this.currentShardKey(), ");
    });

    it("keeps a reactor run off the writer's replay key", () => {
        expect.assertions(1);

        const shard = emitShard({ schema: discover(PLAIN) });

        expect(shard).toContain(
            "functionPath, headroom: this.subscriptionHeadroom(functionPath), onRead: footprint.onRead, onReadRange: footprint.onReadRange, replayKey: false, trusted: true });",
        );
    });
});
