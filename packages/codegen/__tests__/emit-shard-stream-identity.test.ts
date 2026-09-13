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

        // The NAMED type, not an inline structural copy. Method parameters are
        // bivariant, so an inline copy missing a member still compiles against the
        // base — naming the type is what makes `tsc` catch the drift.
        expect(shard).toContain("protected override executeStream(functionPath: string, args: Record<string, unknown>, identity?: SubscriptionIdentity)");
        // Never a bare `buildCtx({ functionPath })` — that is the per-request fallback.
        expect(shard).toContain("this.buildCtx({ functionPath, identity })");
    });

    it("builds ctx.ip from the threaded value, not the shared per-request field", () => {
        expect.assertions(3);

        const shard = emit();
        // The ctx object literal itself — sliced, because `getCurrentIp()` DOES
        // legitimately appear above it, inside the `/rpc` fallback.
        const literal = shard.slice(shard.indexOf("const ctx: Record<string, unknown> = {"));

        // `getCurrentIp()` reads the per-request field a CONCURRENT dispatch owns.
        // A subscription refresh runs inside the writing dispatch's flush, before
        // its `endDispatch`, so reading it here would hand every subscriber the
        // mutating caller's IP. The ctx takes the already-resolved value — the
        // getter (which marks the reactive-cache read scope) returns that local
        // and nothing else.
        expect(literal).toContain("\n                    return ip;\n                },\n");
        expect(literal.slice(0, literal.indexOf("\n            };"))).not.toContain("getCurrentIp");
        // One expression on one discriminant, resolving all three members
        // together — parallel per-field ternaries are how `ip` was forgotten.
        expect(shard).toContain("const caller: SubscriptionIdentity = options.identity ?? {");
    });
});
