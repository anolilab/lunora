/**
 * The `ai-search` fixture: one action reading `ctx.aiSearch` (plan 459), with its
 * whole `_generated/` tree committed.
 *
 * Three layers, like `delta-sync`. Byte-equality against `lunora/_generated` pins
 * the emitted wiring. Named assertions pin the contract the plan states: the
 * binding resolves `config.aiSearch?.(env) ?? env.AI_SEARCH`, falls back to a
 * stub naming the wrangler key, and rides the ActionCtx only. The type-only
 * import of the generated `shard.ts` pulls the tree — including the fixture's
 * `@ts-expect-error` on a query reading `ctx.aiSearch` — into `lint:types`.
 *
 * Plus the gate: on a target rating `aiSearch` unsupported the field is omitted
 * outright, with a `platform_unsupported_feature` diagnostic, never stubbed.
 */
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AiSearch } from "@lunora/bindings/ai-search";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";

import type { CodegenResult } from "../src/index";
import { runCodegen } from "../src/index";
import type { createShardDO } from "./fixtures/ai-search/lunora/_generated/shard";
import { GOLDEN_OUTPUTS, makeFixtureWorkdir } from "./golden-fixtures";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "ai-search");
const expectedDirectory = join(fixtureRoot, "lunora", "_generated");

/** The emitted `createShardDO` config, read off the committed fixture. */
type ShardConfig = NonNullable<Parameters<typeof createShardDO>[0]>;

let workdir: string;
let generated: CodegenResult["generated"];

describe("ai-search fixture", () => {
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

    it("resolves the binding from the override, else env.AI_SEARCH, else a stub naming the wrangler key", () => {
        expect.assertions(5);

        const { shard } = generated;

        expect(shard).toContain(
            "const aiSearchBinding = config.aiSearch?.(env) ?? (env as Record<string, unknown>).AI_SEARCH;\n                const aiSearch: AiSearch = aiSearchBinding ? (aiSearchBinding as AiSearch) : aiSearchStub;",
        );
        expect(shard).toContain("Add an \\`ai_search_namespaces\\` binding (env.AI_SEARCH) to wrangler.jsonc");
        // Annotated, never cast: a method missing from the structural `AiSearch`
        // stub is a compile error in the generated shard, not a silent hole.
        expect(shard).toContain("const aiSearchStub: AiSearch = {");
        expect(shard).not.toContain("as unknown as AiSearch");

        expectTypeOf<ReturnType<NonNullable<ShardConfig["aiSearch"]>>>().toEqualTypeOf<AiSearch>();

        // …and the app builder exposes the override as `defineApp().aiSearch(...)`.
        expect(generated.app).toContain("this.shardExtras.aiSearch = factory");
    });

    it("attaches ctx.aiSearch to the action ctx only", () => {
        expect.assertions(2);

        expect(generated.shard).toContain("ctx.aiSearch = aiSearch;");
        // Typed once, on ActionCtx: the query/mutation interfaces never carry it.
        expect(generated.server.match(/readonly aiSearch: import\("@lunora\/bindings\/ai-search"\)\.AiSearch;/gu)).toHaveLength(1);
    });

    it("omits ctx.aiSearch on a target that rates it unsupported, with a diagnostic", () => {
        expect.assertions(4);

        const nodeWorkdir = makeFixtureWorkdir(fixtureRoot);

        try {
            const result = runCodegen({ lint: false, projectRoot: nodeWorkdir, target: "node" });

            expect(result.platformDiagnostics.filter((diagnostic) => diagnostic.feature === "aiSearch").map((diagnostic) => diagnostic.name)).toStrictEqual([
                "platform_unsupported_feature",
            ]);
            expect(result.generated.server).not.toContain("aiSearch");
            // The shard still NAMES the key — in the studio payload's list of what
            // this target cannot serve — so assert on the wiring, not the word.
            expect(result.generated.shard).not.toMatch(/@lunora\/bindings\/ai-search|aiSearchStub|ctx\.aiSearch =/u);
            expect(result.generated.app).not.toContain("aiSearch");
        } finally {
            rmSync(nodeWorkdir, { force: true, recursive: true });
        }
    }, 300_000);
});
