import type { ExecFileException } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

/**
 * `lunora init` scaffold smoke — end-to-end through the BUILT CLI bin, not the
 * TS sources: `packages/cli/dist/bin.mjs init … --from templates` (the same
 * offline local-templates mode the CLI unit suite uses), then `codegen` via
 * the same bin, then a real `tsc --noEmit` over the scaffold.
 *
 * Offline by construction: template files come from the repo's `templates/`
 * root and the scaffold's `@lunora/*`/`lunorash` deps are satisfied by
 * symlinking the workspace packages (their `dist/` is built by the e2e
 * prerequisite `pnpm run build:packages`) instead of a registry install — the
 * published versions in a template's package.json (`^0.0.0`) don't exist on
 * npm, so a real `pnpm install` is not feasible in this harness. The
 * remote-fetch path is covered by `scripts/clean-machine-smoke.sh`.
 *
 * This spec needs no browser and no playground server — it lives in the e2e
 * suite because it exercises built artifacts (`dist/`), which unit suites
 * deliberately avoid depending on.
 */
const testDirectory = dirname(fileURLToPath(import.meta.url));
const ROOT = join(testDirectory, "..", "..", "..");
const CLI_BIN = join(ROOT, "packages", "cli", "dist", "bin.mjs");
const TEMPLATES_ROOT = join(ROOT, "templates");

const require = createRequire(import.meta.url);

interface RunResult {
    code: number;
    stderr: string;
    stdout: string;
}

const run = async (command: string, args: string[], cwd: string): Promise<RunResult> =>
    new Promise((resolve) => {
        execFile(
            command,
            args,
            { cwd, encoding: "utf8", env: { ...process.env, CI: "true" }, timeout: 90_000 },
            (error: ExecFileException | null, stdout: string, stderr: string) => {
                resolve({ code: error?.code === undefined ? 0 : typeof error.code === "number" ? error.code : 1, stderr, stdout });
            },
        );
    });

let workdir: string;

test.beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "lunora-e2e-scaffold-"));
});

test.afterEach(() => {
    rmSync(workdir, { force: true, recursive: true });
});

test("built CLI scaffolds the standalone template and the scaffold typechecks", async () => {
    test.setTimeout(120_000);

    expect(existsSync(CLI_BIN), `CLI bin missing at ${CLI_BIN} — run \`pnpm run build:packages\` first`).toBe(true);

    // 1. Scaffold offline from the local templates root, via the built bin.
    const init = await run(process.execPath, [CLI_BIN, "init", "scaffold-app", "-t", "standalone", "--from", TEMPLATES_ROOT], workdir);

    expect(init.code, `init failed:\n${init.stdout}\n${init.stderr}`).toBe(0);

    const projectRoot = join(workdir, "scaffold-app");

    expect(existsSync(join(projectRoot, "package.json"))).toBe(true);
    expect(existsSync(join(projectRoot, "lunora", "schema.ts"))).toBe(true);
    expect(existsSync(join(projectRoot, "wrangler.jsonc"))).toBe(true);

    // 2. Satisfy the scaffold's deps from the workspace (offline `pnpm install`
    //    stand-in): the standalone template imports `lunorash/*` and needs
    //    `@cloudflare/workers-types` for its tsconfig `types`.
    const nodeModules = join(projectRoot, "node_modules");

    await mkdir(join(nodeModules, "@cloudflare"), { recursive: true });
    await symlink(join(ROOT, "packages", "lunora"), join(nodeModules, "lunorash"), "dir");
    await symlink(
        realpathSync(join(ROOT, "apps", "playground", "node_modules", "@cloudflare", "workers-types")),
        join(nodeModules, "@cloudflare", "workers-types"),
        "dir",
    );

    // 3. Codegen through the same built bin — parses the scaffold's schema +
    //    function files and emits the `_generated/` triad the sources import.
    const codegen = await run(process.execPath, [CLI_BIN, "codegen"], projectRoot);

    expect(codegen.code, `codegen failed:\n${codegen.stdout}\n${codegen.stderr}`).toBe(0);
    expect(existsSync(join(projectRoot, "lunora", "_generated", "server.ts"))).toBe(true);
    expect(existsSync(join(projectRoot, "lunora", "_generated", "api.ts"))).toBe(true);

    // 4. The scaffold must typecheck exactly as a fresh user would see it.
    const tsc = require.resolve("typescript/lib/tsc.js");
    const typecheck = await run(process.execPath, [tsc, "--noEmit", "-p", projectRoot], projectRoot);

    expect(typecheck.code, `tsc failed:\n${typecheck.stdout}\n${typecheck.stderr}`).toBe(0);
});
