import { describe, expect, it } from "vitest";

import { emitShard } from "../src/emit";

/**
 * `ctx.runQuery(ref, args, { untracked: true })` — the read that does not make
 * the caller reactive.
 *
 * The emitted shard is a STRING; nothing in this package compiles it (see
 * `emitted-shard-contract.ts` for why). So this suite asserts the two things
 * that make the branch correct and that a careless edit would silently break:
 * the untracked path builds its own context WITHOUT the read-footprint hooks,
 * and it pins the identity BY VALUE rather than letting `buildCtx` fall back to
 * the shared per-request fields a concurrent RPC may have re-set.
 */
const shard = (): string => emitShard({ schema: { tables: [], vectorIndexes: [] } });

describe("emitShard — untracked ctx.runQuery", () => {
    it("accepts the options bag and branches on `untracked`", () => {
        expect.assertions(2);

        const emitted = shard();

        expect(emitted).toContain("runOptions?: { untracked?: boolean }");
        expect(emitted).toContain("runOptions?.untracked === true");
    });

    it("builds the untracked sub-context without the read-footprint hooks", () => {
        expect.assertions(2);

        const emitted = shard();
        const branch = emitted.slice(emitted.indexOf("ctx.runQuery ="));

        // The whole point: no `onRead`/`onReadRange` on the sub-context, so the
        // sub-query's reads never reach the subscription's footprint.
        expect(branch).not.toContain("onRead");
        expect(branch).toContain("this.buildCtx({ functionPath: options.functionPath, headroom: options.headroom");
    });

    it("pins the identity by value on the untracked sub-context", () => {
        expect.assertions(1);

        // Load-bearing for RLS: without an explicit `identity`, `buildCtx` reads
        // the shared per-request fields, and a deferred subscription refresh
        // would run the sub-query as whichever user last touched them.
        expect(shard()).toContain("identity: { identity, userId }");
    });

    it("leaves a tracked runQuery, and runMutation/runAction, sharing the caller's ctx", () => {
        expect.assertions(3);

        const emitted = shard();

        // The default path is unchanged — no second ctx, no behaviour change for
        // every call site that does not opt in. (The trailing arguments carry the
        // caller's kind, and for a mutation its transaction wrapper; the ctx the
        // callee runs on is still the caller's.)
        expect(emitted).toContain(": ctx,\n                    contextKind,\n                );");
        expect(emitted).toContain('dispatchRun("mutation", reference.__lunoraRef, fnArgs, ctx, contextKind,');
        expect(emitted).toContain('dispatchRun("action", reference.__lunoraRef, fnArgs, ctx, contextKind)');
    });
});
