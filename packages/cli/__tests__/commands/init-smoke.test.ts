/**
 * Phase 5 verification gate: a scaffolded project is loadable by the rest of
 * the toolchain. Rather than booting Vite (slow + flaky) we compose-test the
 * pieces a real `lunora dev` would invoke: `lunora init -t tanstack-start-react` scaffolds the
 * project (offline, via --from), `runCodegen` parses schema + function files,
 * and `validateWranglerProject` asserts bindings line up with the schema.
 *
 * If any step throws, the scaffold is broken — exactly the failure a fresh
 * `lunora init &amp;& lunora dev` would hit on a clean machine.
 *
 * The unit suite must work offline, so we use `--from` to point at the local
 * templates root rather than hitting GitHub through giget. The remote-fetch
 * path is exercised by `scripts/clean-machine-smoke.sh` against the packed
 * tarball.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCodegen } from "@lunora/codegen";
import { validateWranglerProject } from "@lunora/config/cloudflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runInitCommand } from "../../src/commands/init/handler";
import type { Logger } from "../../src/util/logger";

const silentLogger = (): Logger => {
    return {
        error: () => {},
        info: () => {},
        success: () => {},
        warn: () => {},
    };
};

const testDirectory = dirname(fileURLToPath(import.meta.url));
const templatesRoot = resolve(testDirectory, "..", "..", "..", "..", "templates");

let workdir: string;

describe("lunora init smoke", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-init-smoke-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    /*
     * Each case scaffolds a whole project, parses its schema + function modules
     * through `runCodegen` (a real TypeScript parse), and runs the wrangler
     * validator. That is far more work than a unit test, and it lands against the
     * shared 10s local budget (`tools/get-vitest-config.ts`; CI gets 30s). On an
     * unloaded machine the heaviest case takes ~6.4s of that 10s — thin enough
     * that running anything else concurrently tips it over, which surfaced as
     * intermittent "Test timed out in 10000ms" locally while CI stayed green.
     *
     * Scoped to this suite rather than raising the global default, so genuinely
     * hung unit tests elsewhere still fail fast.
     */
    describe("lunora init → codegen → wrangler validator (Phase 5 smoke)", { timeout: 60_000 }, () => {
        it("vite template produces a project that codegen + wrangler validator accept", async () => {
            expect.assertions(9);

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: silentLogger(),
                name: "smoke-app",
                templateType: "tanstack-start-react",
            });

            expect(result.code).toBe(0);

            const projectRoot = join(workdir, "smoke-app");

            // 1. Codegen against the scaffolded schema must succeed and emit the
            //    three generated files.
            const codegenResult = runCodegen({ projectRoot });

            expect(existsSync(join(codegenResult.outputDirectory, "dataModel.ts"))).toBe(true);
            expect(existsSync(join(codegenResult.outputDirectory, "api.ts"))).toBe(true);
            expect(existsSync(join(codegenResult.outputDirectory, "server.ts"))).toBe(true);

            // The api surface should at minimum mention the `messages` table the
            // vite template ships with — proves codegen parsed schema.ts and the
            // function files, not just emitted boilerplate.
            const api = readFileSync(join(codegenResult.outputDirectory, "api.ts"), "utf8");

            expect(api).toContain("messages");

            // The discovered FUNCTIONS — not just the table — must surface in the
            // generated api. The vite template's `lunora/messages.ts` exports a
            // `list` query and a `send` mutation, both imported from
            // `./_generated/server`. If that procedure import were broken (the
            // class of bug that previously shipped in a template), codegen would
            // fail to discover these functions and they would be absent here.
            // Asserting both names guards the broken-import regression.
            expect(api).toContain("list:");
            expect(api).toContain("send:");

            // 2. Wrangler validator must accept the scaffolded wrangler.jsonc
            //    against the scaffolded schema (SHARD binding, compatibility flag).
            const wranglerResult = validateWranglerProject({ projectRoot });

            expect(wranglerResult.wranglerPath).toBeDefined();
            expect(wranglerResult.problems).toEqual([]);
        });

        it("standalone template produces a project that codegen + wrangler validator accept", async () => {
            expect.assertions(4);

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: silentLogger(),
                name: "worker-smoke",
                templateType: "standalone",
            });

            expect(result.code).toBe(0);

            const projectRoot = join(workdir, "worker-smoke");
            const codegenResult = runCodegen({ projectRoot });

            expect(existsSync(join(codegenResult.outputDirectory, "api.ts"))).toBe(true);

            // The standalone template also ships `lunora/messages.ts` (a `list`
            // query + `send` mutation via the generated-server procedure import).
            // Assert codegen discovered the functions, not merely emitted an
            // empty api — guards the broken-procedure-import regression.
            const api = readFileSync(join(codegenResult.outputDirectory, "api.ts"), "utf8");

            expect(api).toContain("send:");

            const wranglerResult = validateWranglerProject({ projectRoot });

            expect(wranglerResult.problems).toEqual([]);
        });

        it("expo template produces a project that codegen + wrangler validator accept", async () => {
            expect.assertions(4);

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: silentLogger(),
                name: "expo-smoke",
                templateType: "expo",
            });

            expect(result.code).toBe(0);

            const projectRoot = join(workdir, "expo-smoke");
            const codegenResult = runCodegen({ projectRoot });

            expect(existsSync(join(codegenResult.outputDirectory, "api.ts"))).toBe(true);

            // The expo template ships `lunora/messages.ts` (a `list` query + `send`
            // mutation). Assert codegen discovered the functions, not merely emitted
            // an empty api — even though the project also has a non-function helper
            // (`lunora/auth.ts`) alongside the schema.
            const api = readFileSync(join(codegenResult.outputDirectory, "api.ts"), "utf8");

            expect(api).toContain("send:");

            const wranglerResult = validateWranglerProject({ projectRoot });

            expect(wranglerResult.problems).toEqual([]);
        });
    });
});
