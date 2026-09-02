import { describe, expect, it } from "vitest";

import { emitShard } from "../src/emit";
import { emitApp } from "../src/emit-app";

/**
 * The emitted subclass's constructor — the only place `ShardDOOptions` can be
 * supplied, and therefore the only way `@lunora/do`'s per-shard reactive query
 * cache can ever be switched on.
 *
 * It shipped without one: `class extends ShardDOBase {` with no constructor
 * meant `super(state, env)` ran with `options = {}` on every generated shard,
 * so the whole cache was unreachable regardless of what the app configured.
 */
describe("emitShard — reactive cache wiring", () => {
    it("declares the reactiveCache key on ShardDOConfig", () => {
        expect.assertions(1);

        expect(emitShard({ schema: { tables: [], vectorIndexes: [] } })).toContain("reactiveCache?: boolean | { maxBytes?: number; maxEntries?: number };");
    });

    it("declares the relation knobs that were unreachable in every deployment", () => {
        expect.assertions(2);

        const emitted = emitShard({ schema: { tables: [], vectorIndexes: [] } });

        expect(emitted).toContain("maxRelationKeys?: number;");
        expect(emitted).toContain('relationExistsPushDown?: "always" | "auto" | "never";');
    });

    it("always emits a constructor that forwards the config to super(state, env, options)", () => {
        expect.assertions(4);

        // Unconditional: a plain schema (no sourced tables, no TTL sweeps) used to
        // emit a constructor-free subclass, which is exactly the shape that made
        // the cache inert.
        const emitted = emitShard({ schema: { tables: [], vectorIndexes: [] } });

        expect(emitted).toContain("public constructor(state: ShardDOState, env: unknown) {");
        expect(emitted).toContain("...(config.reactiveCache ? { reactiveCache: config.reactiveCache === true ? {} : config.reactiveCache } : {}),");
        expect(emitted).toContain("...(config.maxRelationKeys === undefined ? {} : { maxRelationKeys: config.maxRelationKeys }),");
        expect(emitted).toContain("...(config.relationExistsPushDown === undefined ? {} : { relationExistsPushDown: config.relationExistsPushDown }),");
    });

    it("overrides isQueryFunction against the generated registry", () => {
        expect.assertions(1);

        // The single point where the whole feature goes silently inert: the base
        // class has no function registry, so its `isQueryFunction` answers `false`
        // and `runCachedQuery` returns early on every call — a wired cache that
        // memoizes nothing.
        expect(emitShard({ schema: { tables: [], vectorIndexes: [] } })).toContain(
            // eslint-disable-next-line no-secrets/no-secrets -- false positive: generated-code text asserted verbatim, not a credential
            'protected override isQueryFunction(functionPath: string): boolean {\n            return LUNORA_FUNCTIONS[functionPath]?.kind === "query";',
        );
    });

    it("overrides isPaidFunction against the generated registry", () => {
        expect.assertions(1);

        // Same inert-by-default shape: the base `isPaidFunction` answers `false`,
        // so without this override a `.x402({ price })` query subscribed over the
        // WebSocket is seeded and poked free — the paywall only lives at the origin.
        expect(emitShard({ schema: { tables: [], vectorIndexes: [] } })).toContain(
            // eslint-disable-next-line no-secrets/no-secrets -- false positive: generated-code text asserted verbatim, not a credential
            "protected override isPaidFunction(functionPath: string): boolean {\n            return LUNORA_FUNCTIONS[functionPath]?.x402 !== undefined;",
        );
    });

    it("does not wrap handleRpc dispatch in runCachedQuery — the base /rpc path already does", () => {
        expect.assertions(1);

        // A second wrap would mint a second read scope, so every read would land
        // in the inner tracker and the outer entry would be stored with zero
        // deps, which is permanently stale.
        expect(emitShard({ schema: { tables: [], vectorIndexes: [] } })).not.toContain("this.runCachedQuery(");
    });

    it("threads the per-dispatch read scope from handleRpc into the ctx-db read hooks", () => {
        expect.assertions(3);

        // The scope is what makes the dep tracker per-dispatch instead of
        // per-instance. If `handleRpc` drops it, the hooks fall back to unbound
        // ones and every cached query is stored with an empty dep set — the
        // reads still happen, so nothing fails until a write does not invalidate.
        const emitted = emitShard({ schema: { tables: [], vectorIndexes: [] } });

        expect(emitted).toContain("headroom?: TransactionHeadroomTracker, scope?: QueryReadScope): Promise<unknown>");
        expect(emitted).toContain("onRead: options.onRead ?? this.getCtxDbReadHook(options.scope),");
        expect(emitted).toContain("onReadRange: options.onReadRange ?? (options.scope === undefined ? undefined : this.getCtxDbReadRangeHook(options.scope)),");
    });

    it("spreads ctxDbTuning() first into the ctx-db options so writes invalidate at row + index-range precision", () => {
        expect.assertions(1);

        // Without it the cache only ever invalidates table-wide, and the two
        // relation knobs never reach `createShardCtxDb`.
        expect(emitShard({ schema: { tables: [], vectorIndexes: [] } })).toContain("createShardCtxDb({\n                ...this.ctxDbTuning(),");
    });
});

/** Minimal `EmitAppOptions` with every capability off. */
const appOptions = {
    hasAccess: false,
    hasAi: false,
    hasAnalytics: false,
    hasAuth: false,
    hasBrowser: false,
    hasFramework: false,
    hasGlobal: false,
    hasHyperdrive: false,
    hasHyperdriveGlobal: false,
    hasImages: false,
    hasKv: false,
    hasKvIntrospector: false,
    hasNotify: false,
    hasPayments: false,
    hasQueue: false,
    hasR2sql: false,
    hasScheduler: false,
    hasStorage: false,
    hasVectors: false,
    hasWorkflow: false,
    hasX402: false,
    tableNames: [],
    useUmbrella: false,
    wantsOpenApi: false,
    wantsOpenRpc: false,
};

describe("emitApp — reactive cache wiring", () => {
    it("exposes a `.reactiveCache()` builder method that reaches createShardDO", () => {
        expect.assertions(2);

        // `defineApp()` is what every template uses, and nothing else on the
        // builder reaches `ShardDOConfig` — without both halves the option would
        // be settable and still never read.
        const output = emitApp(appOptions);

        expect(output).toContain("public reactiveCache(config: boolean | { maxBytes?: number; maxEntries?: number } = true): this {");
        expect(output).toContain("reactiveCache: this.reactiveCacheConfig,");
    });
});

describe("emitShard — every writer reaches the cache", () => {
    // This is what makes `ctxDbCacheWired: true` safe to emit. That flag turns OFF
    // the coarse invalidation backstop in `recordChangedTable`, on the promise that
    // no writer skips the cache hooks. When it was emitted while only the
    // user-facing ctx spread the tuning, the seven admin/maintenance writers —
    // studio row edits, TTL sweeps, admin import, CDC apply, external-source pulls,
    // and the data-migration backfill — wrote without invalidating, and the next
    // query answered from the pre-write snapshot indefinitely.
    //
    // Counting rather than matching a fixed list: a writer added later is caught
    // without anyone remembering to extend this test.
    it("spreads ctxDbTuning() into every emitted createShardCtxDb call", () => {
        expect.assertions(2);

        const emitted = emitShard({ schema: { tables: [], vectorIndexes: [] } });

        const writers = emitted.match(/createShardCtxDb\(\{/gu)?.length ?? 0;
        const tunings = emitted.match(/\.\.\.this\.ctxDbTuning\(\),/gu)?.length ?? 0;

        expect(writers).toBeGreaterThan(0);
        expect(tunings).toBe(writers);
    });
});
