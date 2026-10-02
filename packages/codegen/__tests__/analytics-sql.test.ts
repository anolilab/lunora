/**
 * The `analytics-sql` fixture: one action reading `ctx.analyticsSql`, with its
 * whole `_generated/` tree committed.
 *
 * Byte-equality against `lunora/_generated` pins the emitted wiring. Named
 * assertions pin the contract: the binding resolves
 * `config.analyticsSql?.(env) ?? env.ANALYTICS_SQL` and goes through the
 * `createAnalyticsSql` factory, falls back to a stub naming the wrangler key and
 * the REST transport, and rides the ActionCtx only. The type-only import of the
 * generated `shard.ts` pulls the tree — including the fixture's
 * `@ts-expect-error` on a query reading `ctx.analyticsSql` — into `lint:types`.
 *
 * Plus the gate: on a target rating `analyticsSql` unsupported the field is
 * omitted outright, with a `platform_unsupported_feature` diagnostic.
 */
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AnalyticsSqlBindingLike } from "@lunora/bindings/analytics-sql";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";

import type { CodegenResult } from "../src/index";
import { runCodegen } from "../src/index";
import type { createShardDO } from "./fixtures/analytics-sql/lunora/_generated/shard";
import { GOLDEN_OUTPUTS, makeFixtureWorkdir } from "./golden-fixtures";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "analytics-sql");
const expectedDirectory = join(fixtureRoot, "lunora", "_generated");

/** The emitted `createShardDO` config, read off the committed fixture. */
type ShardConfig = NonNullable<Parameters<typeof createShardDO>[0]>;

let workdir: string;
let generated: CodegenResult["generated"];

describe("analytics-sql fixture", () => {
    // ONE codegen run for the file; `lint: false` matches `capture-expected.ts`.
    beforeAll(() => {
        workdir = makeFixtureWorkdir(fixtureRoot);
        generated = runCodegen({ lint: false, projectRoot: workdir }).generated;
    }, 300_000);

    afterAll(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("output matches the committed lunora/_generated files (snapshot)", () => {
        expect.assertions(1);

        const emitted = Object.fromEntries(GOLDEN_OUTPUTS.map(([file, key]) => [file, generated[key]]));
        const committed = Object.fromEntries(GOLDEN_OUTPUTS.map(([file]) => [file, readFileSync(join(expectedDirectory, file), "utf8")]));

        expect(emitted).toStrictEqual(committed);
    });

    it("builds the client from the override, else env.ANALYTICS_SQL, else a stub naming the wrangler key", () => {
        expect.assertions(5);

        const { shard } = generated;

        expect(shard).toContain(
            "const analyticsSqlBinding = config.analyticsSql?.(env) ?? (env as Record<string, unknown>).ANALYTICS_SQL;\n                const analyticsSql: AnalyticsSql = analyticsSqlBinding ? createAnalyticsSql({ binding: analyticsSqlBinding as AnalyticsSqlBindingLike }) : analyticsSqlStub;",
        );
        expect(shard).toContain("Add an \\`analytics\\` binding");
        // The stub points at the token transport for a worker with no binding.
        expect(shard).toContain("createAnalyticsSqlRest({ accountId, apiToken })");
        expect(shard).toContain("const analyticsSqlStub: AnalyticsSql = {");

        // The override returns anything binding-shaped — the real binding or the REST transport.
        expectTypeOf<ReturnType<NonNullable<ShardConfig["analyticsSql"]>>>().toEqualTypeOf<AnalyticsSqlBindingLike>();

        expect(generated.app).toContain("this.shardExtras.analyticsSql = factory");
    });

    it("attaches ctx.analyticsSql to the action ctx only", () => {
        expect.assertions(2);

        expect(generated.shard).toContain("ctx.analyticsSql = analyticsSql;");
        expect(generated.server.match(/readonly analyticsSql: import\("@lunora\/bindings\/analytics-sql"\)\.AnalyticsSql;/gu)).toHaveLength(1);
    });

    it("omits ctx.analyticsSql on a target that rates it unsupported, with a diagnostic", () => {
        expect.assertions(4);

        const nodeWorkdir = makeFixtureWorkdir(fixtureRoot);

        try {
            const result = runCodegen({ lint: false, projectRoot: nodeWorkdir, target: "node" });

            expect(result.platformDiagnostics.filter((diagnostic) => diagnostic.feature === "analyticsSql").map((diagnostic) => diagnostic.name)).toStrictEqual(
                ["platform_unsupported_feature"],
            );
            expect(result.generated.server).not.toContain("analyticsSql");
            expect(result.generated.shard).not.toMatch(/@lunora\/bindings\/analytics-sql|analyticsSqlStub|ctx\.analyticsSql =/u);
            expect(result.generated.app).not.toContain("analyticsSql");
        } finally {
            rmSync(nodeWorkdir, { force: true, recursive: true });
        }
    }, 300_000);
});
