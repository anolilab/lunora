import { describe, expect, it } from "vitest";

import { emitShard } from "../src/emit";

/**
 * The emitted `runReactor` override — the generated half of `onQueryChange`.
 *
 * The shard is a STRING here and nothing in this package compiles it (see
 * `emitted-shard-contract.ts`), so these assertions pin the decisions a careless
 * edit would quietly reverse: the run is footprint-instrumented (or the shard
 * could never skip an unrelated flush), it is transactional (or a handler's
 * writes would not be atomic), and it is built `trusted` with no identity (or an
 * app's reactor would run as whichever user happened to write last — or, under
 * `.rls("required")`, fail closed and never run at all).
 */
const shard = (): string => emitShard({ schema: { tables: [], vectorIndexes: [] } });

const reactorBlock = (): string => {
    const emitted = shard();
    const start = emitted.indexOf("protected override async runReactor");

    return emitted.slice(start, emitted.indexOf("protected override tableRefs", start));
};

describe("emitShard — runReactor override", () => {
    it("is emitted and reports the digest, ran flag, and read footprint", () => {
        expect.assertions(2);

        const block = reactorBlock();

        expect(block).toContain("protected override async runReactor(functionPath: string, previousDigest?: string)");
        // The base stores `digest` as the next baseline and `tables` as the gate
        // that decides whether a later flush re-runs this reactor at all.
        expect(block).toContain("return { digest: outcome.digest, ran: outcome.ran, tables: [...footprint.tables] };");
    });

    it("instruments the run with a read footprint", () => {
        expect.assertions(2);

        const block = reactorBlock();

        expect(block).toContain("const footprint = createReadFootprint();");
        expect(block).toContain("onRead: footprint.onRead, onReadRange: footprint.onReadRange");
    });

    it("runs the dispatch inside a transaction", () => {
        expect.assertions(1);

        // A reactor handler is a mutation, so it goes through the same helper the
        // top-level RPC and `ctx.runMutation` do: an all-or-nothing span, its
        // scheduled jobs held until the commit, its deferred deletes flushed after.
        // Safe to open here because the refresh drain is post-flush background work.
        expect(reactorBlock()).toContain("await this.runMutationTransaction(ctx, async () =>");
    });

    it("builds the context trusted and threads no identity", () => {
        expect.assertions(2);

        const block = reactorBlock();

        expect(block).toContain("trusted: true");
        // No `identity:` at all — a reactor fires because data moved, so there is
        // no caller to inherit and nothing for RLS to scope to.
        expect(block).not.toContain("identity");
    });

    it("refuses a manifest path that is not a mutation", () => {
        expect.assertions(1);

        expect(reactorBlock()).toContain('if (!registered || registered.kind !== "mutation")');
    });

    it("gates RLS on the trusted flag rather than hard-coding it on", () => {
        expect.assertions(2);

        const emitted = shard();

        expect(emitted).toContain("enforceRls: options.trusted !== true,");
        // An init hook has no caller identity either, so it joins the same tier;
        // connect/disconnect carry a verified user and stay guarded.
        expect(emitted).toContain('trusted: registered.lifecycle === "init"');
    });

    it("exposes the reactor manifest through lifecycleHookPaths", () => {
        expect.assertions(1);

        expect(shard()).toContain('lifecycleHookPaths(event: "connect" | "disconnect" | "init" | "reactor")');
    });
});
