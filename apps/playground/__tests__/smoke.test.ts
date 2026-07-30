/**
 * Phase 7 verification gate: the playground project — our exemplar app —
 * stays loadable end-to-end by the rest of the toolchain.
 *
 * If a refactor in `lunora-codegen` or `lunora-config` breaks the playground,
 * we catch it here instead of on a deploy. We deliberately don't boot Vite or
 * `wrangler dev` (slow, flaky inside the workspace) — we compose-check the
 * same pieces a real `lunora dev` would run:
 *
 *   1. `runCodegen`               → parses schema + functions under `lunora/`
 *   2. `validateWranglerProject`  → asserts bindings line up with the schema
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCodegen } from "@lunora/codegen";
import { validateWranglerProject } from "@lunora/config/cloudflare";
import { describe, expect, it } from "vitest";

const testDirectory = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = join(testDirectory, "..");

describe("playground compose smoke (Phase 7)", () => {
    it("runCodegen parses schema + functions and emits the _generated triad", () => {
        expect.assertions(7);

        const result = runCodegen({ projectRoot });

        expect(existsSync(join(result.outputDirectory, "dataModel.ts"))).toBe(true);
        expect(existsSync(join(result.outputDirectory, "api.ts"))).toBe(true);
        expect(existsSync(join(result.outputDirectory, "server.ts"))).toBe(true);

        expect(result.generated.dataModel).toContain("messages");
        expect(result.generated.dataModel).toContain("channels");
        expect(result.generated.dataModel).toContain("users");
        expect(result.generated.api).toContain("messages");
    });

    it("validateWranglerProject finds no problems for the shipped wrangler.jsonc", () => {
        expect.assertions(3);

        const result = validateWranglerProject({ projectRoot });

        expect(result.wranglerPath).toBeDefined();
        expect(result.problems).toEqual([]);
        expect(result.report.valid).toBe(true);
    });

    it("wrangler.jsonc declares the bindings the schema requires", () => {
        expect.assertions(7);

        const wranglerPath = join(projectRoot, "wrangler.jsonc");
        const text = readFileSync(wranglerPath, "utf8");

        // SHARD DO for shard-local tables (`messages`)
        expect(text).toContain('"SHARD"');
        expect(text).toContain("ShardDO");
        // SCHEDULER DO for `lunora-scheduler`
        expect(text).toContain('"SCHEDULER"');
        expect(text).toContain("SchedulerDO");
        // D1 binding for `.global()` tables (`users`, `channels`)
        expect(text).toContain("d1_databases");
        // R2 binding used by the avatar upload mutation
        expect(text).toContain("r2_buckets");
        expect(text).toContain("FILES");
    });
});
