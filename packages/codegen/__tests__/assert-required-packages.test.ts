import { describe, expect, it } from "vitest";

import assertRequiredPackages, { requiredPackagesFor } from "../src/assert-required-packages";
import { CAPABILITIES } from "../src/capabilities";
import type { FeatureUsage } from "../src/discover/feature-usage";
import type { SchemaIR, TableIR } from "../src/ir";

const table = (overrides: Partial<TableIR> = {}): TableIR =>
    ({
        indexes: [],
        name: "messages",
        shape: {},
        ...overrides,
    }) as TableIR;

const schemaWith = (overrides: Partial<SchemaIR> = {}): SchemaIR => {
    return {
        tables: [table()],
        vectorIndexes: [],
        ...overrides,
    };
};

const names = (...packages: ReadonlyArray<{ name: string }>): ReadonlyArray<string> => packages.map((entry) => entry.name);

/** A full {@link FeatureUsage} record with only the named capabilities flipped on. */
const usageWith = (on: Partial<FeatureUsage>): FeatureUsage => {
    return {
        ...(Object.fromEntries(CAPABILITIES.map((capability) => [capability.key, false])) as FeatureUsage),
        ...on,
    };
};

describe("requiredPackagesFor", () => {
    it("requires @lunora/storage for a v.storage() column, which no dependency implies", () => {
        expect.assertions(1);

        // `v.storage()` lives in `@lunora/values` and is documented as an ordinary
        // data type, so a `lunorash`-only project declares nothing that pulls in
        // `@lunora/storage` — yet `_generated/app.ts` imports it. Codegen exited 0
        // and the build died with `Cannot find module` inside a generated file.
        expect(names(...requiredPackagesFor(schemaWith(), { storage: true }))).toStrictEqual(["@lunora/storage"]);
    });

    it("requires @lunora/scheduler when a cron is declared", () => {
        expect.assertions(1);

        expect(names(...requiredPackagesFor(schemaWith(), { scheduler: true }))).toStrictEqual(["@lunora/scheduler"]);
    });

    it("requires @lunora/sql-store alongside @lunora/hyperdrive for a hyperdrive-backed global table", () => {
        expect.assertions(1);

        // `_generated/app.ts` imports `@lunora/sql-store` types directly; being a
        // transitive dependency of `@lunora/hyperdrive` does not make the specifier
        // resolvable under a strict node_modules layout.
        const schema = schemaWith({ tables: [table({ globalBackend: "hyperdrive", shardMode: "global" })] });

        expect(names(...requiredPackagesFor(schema))).toStrictEqual(["@lunora/hyperdrive", "@lunora/sql-store"]);
    });

    it("requires nothing for a plain sharded schema with no add-on signals", () => {
        expect.assertions(1);

        expect(requiredPackagesFor(schemaWith())).toStrictEqual([]);
    });
});

describe("assertRequiredPackages", () => {
    it("throws naming every missing package at once", () => {
        expect.assertions(2);

        expect(() => {
            assertRequiredPackages(schemaWith(), new Set(["lunorash"]), { scheduler: true, storage: true });
        }).toThrow("@lunora/storage");

        expect(() => {
            assertRequiredPackages(schemaWith(), new Set(["lunorash"]), { scheduler: true, storage: true });
        }).toThrow("@lunora/scheduler");
    });

    it("accepts a project that declares them", () => {
        expect.assertions(1);

        expect(() => {
            assertRequiredPackages(schemaWith(), new Set(["@lunora/scheduler", "@lunora/storage", "lunorash"]), { scheduler: true, storage: true });
        }).not.toThrow();
    });

    it("throws for a ctx.kv read in a project that declares only the umbrella", () => {
        expect.assertions(1);

        // The umbrella re-exports only the base packages, so `lunorash` alone does
        // not make `@lunora/bindings/kv` resolvable.
        expect(() => {
            assertRequiredPackages(schemaWith(), new Set(["lunorash"]), { usage: usageWith({ kv: true }) });
        }).toThrow("@lunora/bindings");
    });
});

describe("requiredPackagesFor — ctx.* usage", () => {
    it("requires @lunora/bindings for a bare ctx.kv read", () => {
        expect.assertions(1);

        // `discoverFeatureUsage` flips `kv` on a bare `ctx.kv` read, and the shard
        // emitter then imports `@lunora/bindings/kv` — in a project whose only
        // declared dependency may be `lunorash`. Codegen exited 0 and `tsc` failed
        // with `Cannot find module` inside `_generated/shard.ts`.
        expect(names(...requiredPackagesFor(schemaWith(), { usage: usageWith({ kv: true }) }))).toStrictEqual(["@lunora/bindings"]);
    });

    it("requires @lunora/ai for a bare ctx.ai read", () => {
        expect.assertions(1);

        expect(names(...requiredPackagesFor(schemaWith(), { usage: usageWith({ ai: true }) }))).toStrictEqual(["@lunora/ai"]);
    });

    it("collapses the @lunora/bindings subpaths to one entry", () => {
        expect.assertions(1);

        const usage = usageWith({ analytics: true, images: true, kv: true, pipelines: true, r2sql: true });

        expect(names(...requiredPackagesFor(schemaWith(), { usage }))).toStrictEqual(["@lunora/bindings"]);
    });

    it("covers every ctx.* capability whose generated import is usage-gated", () => {
        expect.assertions(1);

        const usage = usageWith({
            access: true,
            ai: true,
            analytics: true,
            browser: true,
            hyperdrive: true,
            images: true,
            kv: true,
            payments: true,
            pipelines: true,
            r2sql: true,
            x402: true,
        });

        expect([...names(...requiredPackagesFor(schemaWith(), { usage }))].toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "@lunora/ai",
            "@lunora/bindings",
            "@lunora/browser",
            "@lunora/cloudflare-access",
            "@lunora/hyperdrive",
            "@lunora/payment",
            "@lunora/x402",
        ]);
    });

    it("requires nothing when no capability is used", () => {
        expect.assertions(1);

        expect(requiredPackagesFor(schemaWith(), { usage: usageWith({}) })).toStrictEqual([]);
    });
});
