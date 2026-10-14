import { describe, expect, it } from "vitest";

import { moduleOf } from "../../../../shared/architecture-manifest";
import { buildArchitecture } from "../../src/architecture";
import { resolveModules } from "../../src/discover/modules";
import type { SchemaIR, TableIR } from "../../src/ir";

const table = (name: string, extra: Partial<TableIR> = {}): TableIR =>
    ({ indexes: [], name, rankIndexes: [], relations: [], searchIndexes: [], shape: {}, shardMode: "default", vectorIndexes: [], ...extra }) as TableIR;

const schema = (...tables: TableIR[]): SchemaIR => {
    return { tables, vectorIndexes: [] };
};

describe("resolveModules", () => {
    it("adds a registry component that owns its folder, and a package component that owns none", () => {
        expect.assertions(4);

        const modules = resolveModules(
            [],
            schema(table("ratelimit_buckets", { extensionKey: "ratelimit" }), table("agent_runs", { extensionFromPackage: true, extensionKey: "agent" })),
            [],
        );

        expect(modules).toStrictEqual([
            { installed: true, name: "agent", ownsFolder: false, tables: ["agent_runs"] },
            { installed: true, name: "ratelimit", tables: ["ratelimit_buckets"] },
        ]);
        // The registry copy-in's folder belongs to it; an app's own `agent/` folder stays the app's.
        expect(moduleOf(modules, "ratelimit/schema")).toBe("ratelimit");
        expect(moduleOf(modules, "agent/tools")).toBeUndefined();
        expect(moduleOf(modules, "ratelimit")).toBeUndefined();
    });

    it("keeps a table a declared module claims with that module", () => {
        expect.assertions(1);

        const declared = [{ name: "billing", tables: ["voting_votes"] }];

        expect(resolveModules(declared, schema(table("voting_votes", { extensionKey: "voting" })), [])).toStrictEqual(declared);
    });

    it("rejects a table two declared modules claim", () => {
        expect.assertions(1);

        expect(() =>
            resolveModules(
                [
                    { name: "a", tables: ["posts"] },
                    { name: "b", tables: ["posts"] },
                ],
                schema(table("posts")),
                [],
            ),
        ).toThrow(/claimed by both/u);
    });

    it("keeps a package component's ownsFolder: false in the manifest", () => {
        expect.assertions(1);

        const tables = schema(table("agent_runs", { extensionFromPackage: true, extensionKey: "agent" }));
        const modules = resolveModules([], tables, []);
        const manifest = buildArchitecture({
            callEdges: [],
            crons: [],
            functions: [],
            httpRoutes: [],
            inserts: [],
            modules,
            queries: [],
            queues: [],
            schema: tables,
            services: [],
            tableWrites: [],
            topics: [],
            workflowCalls: [],
            workflows: [],
        });

        expect(manifest.modules).toStrictEqual([{ installed: true, name: "agent", ownsFolder: false, tables: ["agent_runs"] }]);
    });
});
