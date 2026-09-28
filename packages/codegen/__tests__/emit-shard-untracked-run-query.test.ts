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
        const branch = emitted.slice(emitted.indexOf("target.runQuery ="));

        // The whole point: no `onRead`/`onReadRange` on the sub-context, so the
        // sub-query's reads never reach the subscription's footprint.
        expect(branch).not.toContain("onRead");
        expect(branch).toContain("this.buildCtx({ bookmarks: options.bookmarks, functionPath: options.functionPath, headroom: options.headroom");
    });

    it("runs the untracked sub-context as a query", () => {
        expect.assertions(2);

        const emitted = shard();

        // It keeps the caller's `functionPath` for attribution, so the kind is
        // overridden rather than looked up — otherwise a sub-query spawned from a
        // mutation could compose a mutation of its own.
        expect(emitted).toContain('identity: caller, kind: "query", scope: options.scope })');
        expect(emitted).toContain("const contextKind = options.kind ?? ");
    });

    it("pins the identity by value on the untracked sub-context", () => {
        expect.assertions(1);

        // Load-bearing for RLS: without an explicit `identity`, `buildCtx` reads
        // the shared per-request fields, and a deferred subscription refresh
        // would run the sub-query as whichever user last touched them. `ip` rides
        // the same channel for the same reason — the refresh runs inside the
        // writing dispatch, so the shared field is the WRITER's. The already
        // resolved `caller` is forwarded rather than rebuilt member by member, so
        // the sub-context cannot drift from the context it was spawned from.
        expect(shard()).toContain("identity: caller");
    });

    it("runs a tracked runQuery on a query view of the caller's ctx", () => {
        expect.assertions(5);

        const emitted = shard();

        expect(emitted).toContain(": queryContext(),\n                        kind,\n                    );");
        // A query ctx is already its own view, so the hot subscription path
        // allocates nothing.
        expect(emitted).toContain('if (contextKind === "query") {\n                    return ctx;');
        // No request origin, in `ctx.origin` or the storage signed-URL fallback,
        // so a composed query behaves as it does when called directly or live.
        expect(emitted).toContain("origin: { enumerable: true, value: undefined },");
        expect(emitted).toContain("storage: { enumerable: true, value: requestOrigin === undefined ? storage : makeStorage() },");
        // Its own `run*` are guarded as a query's.
        expect(emitted).toContain('installRun(queryView, "query");');
    });

    it("copies the caller's ctx by descriptor so the `ip` getter is not read", () => {
        expect.assertions(1);

        // A spread would invoke the getter and mark the dispatch's reactive-cache
        // scope as address-dependent for every composed query.
        expect(shard()).toContain("...Object.getOwnPropertyDescriptors(ctx),");
    });

    it("keeps runMutation/runAction on the caller's ctx and kind", () => {
        expect.assertions(2);

        const emitted = shard();

        expect(emitted).toContain('dispatchRun("mutation", reference.__lunoraRef, fnArgs, target, kind,');
        expect(emitted).toContain("installRun(ctx, contextKind);");
    });
});
