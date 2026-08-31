import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import discoverSchema from "../src/discover/schema";
import { emitShard } from "../src/emit";

/**
 * Plan 207 step 2: alarm-driven writes (TTL sweeps) must be metered like every
 * other write path, via a BY-VALUE tracker threaded through the override rather
 * than an ambient instance field (which would race a concurrent `/rpc` dispatch or
 * a sibling alarm work item). The sweep routes through `runShardWrite` — the one
 * single-row writer seam — which is emitted unconditionally for any schema with
 * tables, so no `.ttl()`/`.source()` is needed to exercise it (unlike
 * `pollExternalSources`, see `emit-external-source.test.ts`).
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

describe("emitShard — runShardWrite alarm headroom (plan 207)", () => {
    it("threads an optional headroom parameter through to the writer, falling back to the per-dispatch meter", () => {
        expect.assertions(4);

        const shard = emitShard({ schema: discover(PLAIN) });

        // The signature accepts an explicit BY-VALUE override (the TTL sweep's
        // fresh per-pass tracker) ...
        expect(shard).toContain("protected override async runShardWrite(args: RunShardWriteArgs, headroom?: TransactionHeadroomTracker)");
        // ... which the writer uses when supplied, and otherwise falls back to
        // `this.transactionHeadroom()` — which for an ADMIN rpc is `undefined`,
        // since `handleAdminRpc` answers before `beginDispatch`.
        expect(shard).toContain("headroom: headroom ?? this.transactionHeadroom()");
        // Every by-id op pins its table, so a row that vanished between an admin
        // read and this write cannot fall through to the `.global()` D1 twin.
        expect(shard).toContain('await writer.delete(args.id ?? "", args.table);');
        // `TransactionHeadroomTracker` is a TYPE-only reference here — it must
        // already be in the generated file's import list (buildDoTypeImports),
        // not a new runtime import this override would need.
        expect(shard).toContain("TransactionHeadroomTracker");
    });
});

describe("emitShard — handleRpc dispatch-race fix (plan 207 step 3)", () => {
    it("accepts a by-value headroom override and threads it straight into buildCtx, bypassing the shared-field fallback for this dispatch", () => {
        expect.assertions(2);

        const shard = emitShard({ schema: discover(PLAIN) });

        // The main `/rpc` dispatch (`handleFetchCloudflare`) now passes its
        // locally-captured tracker here explicitly; `dispatchLifecycle` /
        // `handleRunAs` (which mint no tracker) omit it and fall through to
        // `buildCtx`'s own `options.headroom ?? this.transactionHeadroom()`.
        expect(shard).toContain(
            "public override async handleRpc(functionPath: string, args: Record<string, unknown>, headroom?: TransactionHeadroomTracker, scope?: QueryReadScope): Promise<unknown>",
        );
        // `trusted` rides alongside it (an `onShardInit` hook has no caller
        // identity, so RLS has no user to scope to) — the assertion here is that
        // `headroom` is still threaded BY VALUE rather than falling back to the
        // shared field, which is what this suite exists to protect.
        expect(shard).toContain('const ctx = this.buildCtx({ functionPath, headroom, scope, trusted: registered.lifecycle === "init" });');
    });
});
