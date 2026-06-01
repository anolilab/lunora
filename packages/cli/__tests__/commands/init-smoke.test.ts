/**
 * Phase 5 verification gate: a scaffolded project is loadable by the rest of
 * the toolchain. Rather than booting Vite (slow + flaky) we compose-test the
 * pieces a real `cirrus dev` would invoke: `cirrus init -t vite` scaffolds the
 * project (offline, via --from), `runCodegen` parses schema + function files,
 * and `validateWranglerProject` asserts bindings line up with the schema.
 *
 * If any step throws, the scaffold is broken — exactly the failure a fresh
 * `cirrus init &amp;& cirrus dev` would hit on a clean machine.
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

import { runCodegen } from "@cirrus/codegen";
import { validateWranglerProject } from "@cirrus/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runInitCommand } from "../../src/commands/init.js";
import type { Logger } from "../../src/util/logger.js";

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

describe("cirrus init smoke", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-cli-init-smoke-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("cirrus init → codegen → wrangler validator (Phase 5 smoke)", () => {
        it("vite template produces a project that codegen + wrangler validator accept", async () => {
            expect.assertions(7);

            const result = await runInitCommand({
                cwd: workdir,
                from: templatesRoot,
                logger: silentLogger(),
                name: "smoke-app",
                templateType: "vite",
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

            // 2. Wrangler validator must accept the scaffolded wrangler.jsonc
            //    against the scaffolded schema (SHARD binding, compatibility flag).
            const wranglerResult = validateWranglerProject({ projectRoot });

            expect(wranglerResult.wranglerPath).toBeDefined();
            expect(wranglerResult.problems).toEqual([]);
        });

        it("standalone template produces a project that codegen + wrangler validator accept", async () => {
            expect.assertions(3);

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

            const wranglerResult = validateWranglerProject({ projectRoot });

            expect(wranglerResult.problems).toEqual([]);
        });
    });
});
