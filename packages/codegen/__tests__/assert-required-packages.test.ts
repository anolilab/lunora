import { describe, expect, it } from "vitest";

import assertRequiredPackages, { requiredPackagesFor } from "../src/assert-required-packages";
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
});
