/**
 * The generated `executeStream` must thread the socket's verified identity into
 * `buildCtx`, exactly as `executeSubscription` does.
 *
 * `buildCtx` falls back to `this.getCurrentUserId()` / `getCurrentIdentity()` —
 * per-request fields only an `/rpc` dispatch stamps. A `stream` frame is
 * dispatched fire-and-forget and its iterator is pulled long afterwards,
 * interleaved with unrelated dispatches, so without the explicit thread an
 * `rls()` / `ctx.auth`-scoped stream evaluates as nobody while the shard is
 * idle and as a concurrent RPC's caller while it is not.
 *
 * The paired half of this assertion is `emitted-shard-contract.ts`, which
 * proves the three-parameter override actually compiles against `ShardDO`.
 */
import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import discoverSchema from "../src/discover/schema";
import { emitShard } from "../src/emit";

const SCHEMA = `
    import { defineSchema, defineTable, v } from "@lunora/server";

    export const schema = defineSchema({
        messages: defineTable({ text: v.string() }),
    });
`;

const emit = (): string => {
    const project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true });
    const schemaPath = "/virtual/lunora/schema.ts";

    project.createSourceFile(schemaPath, SCHEMA);

    return emitShard({ schema: discoverSchema(project, schemaPath) });
};

describe("emitted executeStream identity", () => {
    it("takes the socket identity and hands it to buildCtx", () => {
        expect.assertions(2);

        const shard = emit();

        expect(shard).toContain(
            "protected override executeStream(functionPath: string, args: Record<string, unknown>, identity?: { identity?: Record<string, unknown>; userId?: string })",
        );
        // Never a bare `buildCtx({ functionPath })` — that is the per-request fallback.
        expect(shard).toContain("this.buildCtx({ functionPath, identity })");
    });
});
