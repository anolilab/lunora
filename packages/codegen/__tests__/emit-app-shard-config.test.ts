import { describe, expect, it } from "vitest";

import { emitApp } from "../src/emit-app";

/** Minimal `EmitAppOptions` with every capability off — these knobs must be reachable regardless. */
const baseOptions = {
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

/**
 * The plain-data `ShardDOConfig` knobs that `createShardDO` reads and the docs
 * tell you to pass. `emit-app.ts` owns the ONLY `createShardDO(...)` call a
 * `defineApp()` project makes, so a knob with no builder method here is a knob
 * no app can set — whatever the generated type says.
 */
describe("emitApp — ShardDOConfig knobs reachable from the builder", () => {
    /* eslint-disable no-secrets/no-secrets -- false positive: `NonNullable<ShardConfig["…"]>` is emitted TypeScript asserted below, not a credential. */
    it("emits an `.observability()` method that reaches createShardDO", () => {
        expect.assertions(3);

        // The DO half of observability. Without it every in-handler `ctx.log`
        // line, `ctx.trace` span and `ctx.metrics` measurement stayed in the
        // shard's local ring buffer and reached no collector, while the worker's
        // own `onRpc` events shipped — so telemetry looked wired and was half
        // missing.
        const output = emitApp(baseOptions);

        expect(output).toContain('public observability(selector: NonNullable<ShardConfig["observability"]>): this {');
        expect(output).toContain("this.observabilitySink = selector;");
        expect(output).toContain("...(this.observabilitySink === undefined ? {} : { observability: this.observabilitySink }),");
    });

    it("emits `.maxRelationKeys()` and `.relationExistsPushDown()` that reach createShardDO", () => {
        expect.assertions(4);

        const output = emitApp(baseOptions);

        expect(output).toContain('public maxRelationKeys(limit: NonNullable<ShardConfig["maxRelationKeys"]>): this {');
        expect(output).toContain("...(this.maxRelationKeysLimit === undefined ? {} : { maxRelationKeys: this.maxRelationKeysLimit }),");
        expect(output).toContain('public relationExistsPushDown(mode: NonNullable<ShardConfig["relationExistsPushDown"]>): this {');
        expect(output).toContain("...(this.relationExistsPushDownMode === undefined ? {} : { relationExistsPushDown: this.relationExistsPushDownMode }),");
    });

    it("declares the ShardConfig alias the always-on methods type against, with no capability enabled", () => {
        expect.assertions(1);

        // The alias used to be emitted only when a long-tail capability method
        // was, so the three always-on methods above would reference a type that
        // is not there for a plain app.
        expect(emitApp(baseOptions)).toContain("type ShardConfig = NonNullable<Parameters<typeof createShardDO>[0]>;");
    });
    /* eslint-enable no-secrets/no-secrets -- re-enable after the emitted-type assertions above */
});
