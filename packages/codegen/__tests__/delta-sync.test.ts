/**
 * The `delta-sync` fixture: a project that declares BOTH `defineShape`s and
 * `.global()` tables, with its whole `_generated/` tree committed.
 *
 * **Why it exists.** Every emission in the local-first sync path is gated —
 * `resolveShape` on `hasShapes`, `readGlobalShapeRows`/`readGlobalChangedTables`
 * on `hasShapes && hasGlobalTables`. No fixture, example or template declared a
 * shape, so none of those gates ever opened in committed output and the
 * subsystem shipped with nothing behind it. That is how the global writers came
 * to be built without the shard's `cdc` flag: the unit tests construct the
 * writers directly with CDC on, so the one thing nobody asserted was what
 * codegen actually wires — and a global `__cdc_log` that is never written looks,
 * from the shard side, exactly like a backend with CDC disabled.
 *
 * Three layers, cheapest first.
 *
 * Byte-equality against `lunora/_generated`: any drift in the generated
 * delta-sync code shows up as a diff a reviewer reads. That claim only holds
 * because the regeneration workdir resolves types the way a real app does — see
 * `makeFixtureWorkdir`, which is what stopped the golden from recording
 * `unknown` for every inferred return type.
 *
 * Named assertions on the CDC threading, so a regression reports the defect
 * rather than "snapshot differs".
 *
 * A type-only import of the generated `shard.ts`, which pulls the fixture's whole
 * generated tree (shard → functions → server → dataModel → the app's own
 * `schema.ts`/`shapes.ts`) into the program, where `lint:types` compiles it. This
 * is the layer the substring tests never had: a genuine type error in emitted
 * code used to pass the entire suite. It is also why this fixture keeps its
 * golden at `lunora/_generated` rather than under `expected/` — emitted code says
 * `import schema from "../schema.js"`, which only resolves from inside the app
 * tree it was written for.
 */
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCodegen } from "../src/index";
import type { createShardDO } from "./fixtures/delta-sync/lunora/_generated/shard";
import { GOLDEN_OUTPUTS, makeFixtureWorkdir } from "./golden-fixtures";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "delta-sync");
const expectedDirectory = join(fixtureRoot, "lunora", "_generated");

/**
 * The emitted `createShardDO` config, read off the committed fixture rather than
 * off a hand-written mirror — these aliases are what makes layer 3 above check
 * the *generated* file and not a copy of it.
 */
type ShardConfig = NonNullable<Parameters<typeof createShardDO>[0]>;

/** The per-request context the shard hands its D1 global-writer thunk. */
type GlobalRequest = NonNullable<Parameters<NonNullable<ShardConfig["d1"]>>[1]>;

let workdir: string;

describe("delta-sync fixture", () => {
    beforeEach(() => {
        workdir = makeFixtureWorkdir(fixtureRoot);
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    // `lint: false` matches `capture-expected.ts`: it keeps `LUNORA_ADVISORIES`
    // empty so the golden stays decoupled from advisor behaviour.
    it("output matches the committed lunora/_generated files (snapshot)", () => {
        expect.assertions(1);

        const { generated } = runCodegen({ lint: false, projectRoot: workdir });

        // One assertion over a filename→content map rather than one per file, so
        // a drift report names every file that moved instead of stopping at the
        // first.
        const emitted = Object.fromEntries(GOLDEN_OUTPUTS.map(([file, key]) => [file, generated[key]]));
        const committed = Object.fromEntries(GOLDEN_OUTPUTS.map(([file]) => [file, readFileSync(join(expectedDirectory, file), "utf8")]));

        expect(emitted).toStrictEqual(committed);
    });

    it("emits the shape overrides only a shapes-plus-global project reaches", () => {
        expect.assertions(4);

        const { shard } = runCodegen({ lint: false, projectRoot: workdir }).generated;

        expect(shard).toContain("protected override resolveShape(");
        expect(shard).toContain("protected override async readGlobalShapeRows(");
        expect(shard).toContain("protected override async readGlobalChangedTables(");
        // The changed-tables tick is the whole point of the global changelog: it
        // asks which tables moved, so a tick that omits a shape's table skips
        // that shape's membership drain entirely.
        expect(shard).toContain("globalDb.cdcChangedTables?.(sinceSeq, { cursorOnly })");
    });

    it("threads the shard's cdc flag into every global-writer build", () => {
        expect.assertions(5);

        const { app, shard } = runCodegen({ lint: false, projectRoot: workdir }).generated;

        // All three shard-side builds of the global writer — the ctx-db one and
        // the two shape overrides. Miss any one and that path writes/reads a
        // `__cdc_log` the others never see.
        expect([...shard.matchAll(/this\.globalCdcOptions\(config\.cdc \?\? false\)/gu)]).toHaveLength(3);
        // …and the app-side factory has to forward what the shard sent. Without
        // this the global `__cdc_log` is never written at all and the shape
        // poll's changed-tables fast path is unreachable.
        expect(app).toContain("cdc: request?.cdc ?? false,");
        expect(shard).toContain("runShardMigrations(this.sql as SqlExec, schema as unknown as SchemaLike, { cdc: config.cdc ?? false");
        // …and the app builder has to be able to turn it ON. It could not: the
        // whole chain above bottoms out in `config.cdc`, which no `defineApp()`
        // method assigned, so the subsystem was unreachable from the only
        // composition path the templates use.
        expect(app).toContain("public cdc(enabled = true): this {");
        expect(app).toContain("cdc: this.cdcEnabled,");
    });

    it("types the cdc flag through the emitted config (compile-checked)", () => {
        expect.assertions(2);

        // Both locals are verified by `tsc` (via `lint:types`), not at runtime:
        // they stop compiling the moment `cdc` leaves the shard config or the
        // global-writer request, which is exactly how the flag went missing.
        const configurable: ShardConfig["cdc"] = true;
        const forwardable: GlobalRequest["cdc"] = true;

        expect(configurable).toBe(true);
        expect(forwardable).toBe(true);
    });
});
