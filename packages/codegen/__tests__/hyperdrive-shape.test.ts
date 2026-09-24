/**
 * The `hyperdrive-shape` fixture: `delta-sync` with its `.global()` table moved
 * to the Hyperdrive backend.
 *
 * **Why it exists.** `delta-sync` pins the shape overrides, but only against D1,
 * and the two backends emit different code on the very lines those overrides
 * live on — `config.d1` vs `config.hyperdriveGlobal`, whose declared request
 * types differ. So the Hyperdrive spelling had no compiled output anywhere, and
 * shipped emitting a `shard.ts` that does not typecheck: `readGlobalChangedTables`
 * handed the narrower Hyperdrive thunk an inline object literal carrying a
 * `bookmark` the thunk does not declare (TS2353). Every Hyperdrive-global app
 * with a `defineShape` got an uncompilable generated tree, and codegen exited 0.
 *
 * The load-bearing layer is the type-only import of the generated `shard.ts`
 * below: it pulls the fixture's whole generated tree into the program, where
 * `lint:types` compiles it. The substring assertions only report the defect by
 * name when it comes back.
 */
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CodegenResult } from "../src/index";
import { runCodegen } from "../src/index";
import type { createShardDO } from "./fixtures/hyperdrive-shape/lunora/_generated/shard";
import { GOLDEN_OUTPUTS, makeFixtureWorkdir } from "./golden-fixtures";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "hyperdrive-shape");
const expectedDirectory = join(fixtureRoot, "lunora", "_generated");

/** The emitted `createShardDO` config, read off the committed fixture rather than a hand-written mirror. */
type ShardConfig = NonNullable<Parameters<typeof createShardDO>[0]>;

/** The per-request context the shard hands its Hyperdrive global-writer thunk. */
type HyperdriveGlobalRequest = NonNullable<Parameters<NonNullable<ShardConfig["hyperdriveGlobal"]>>[1]>;

let workdir: string;
let generated: CodegenResult["generated"];

describe("hyperdrive-shape fixture", () => {
    // ONE codegen run for the whole file — every assertion reads the same
    // emission, and a per-test run pays the full ts-morph cold start each time.
    // `lint: false` matches `capture-expected.ts`.
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

    it("routes both shape overrides through the Hyperdrive global thunk", () => {
        expect.assertions(3);

        const { shard } = generated;

        expect(shard).toContain("protected override async readGlobalShapeRows(");
        expect(shard).toContain("protected override async readGlobalChangedTables(");
        expect(shard).not.toContain("config.d1?.(env,");
    });

    it("binds every widened global request to a named local before handing it to the thunk", () => {
        expect.assertions(2);

        const { shard } = generated;

        // The Hyperdrive thunk's declared request type has no `bookmark`, so an
        // INLINE literal carrying one is an excess-property error. All three call
        // sites (the dispatch path plus both shape overrides) therefore go through
        // a named local, which widens to the literal's own type and is assignable.
        expect([...shard.matchAll(/const globalRequest = \{/gu)]).toHaveLength(3);
        expect(shard).not.toMatch(/hyperdriveGlobal\?\.\(env, \{/u);
    });

    it("types the Hyperdrive global request through the emitted config (compile-checked)", () => {
        expect.assertions(2);

        // Verified by `tsc` via `lint:types`, not at runtime. `bookmark` is
        // deliberately absent from this type — the assertion is that the emitter
        // knows that and does not try to pass one inline.
        const cdc: HyperdriveGlobalRequest["cdc"] = true;
        const hasBookmark = "bookmark" in ({} as HyperdriveGlobalRequest);

        expect(cdc).toBe(true);
        expect(hasBookmark).toBe(false);
    });
});
