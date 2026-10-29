import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { createBuilder, resolveConfig } from "vite";
import { afterAll, bench, describe } from "vitest";

import { lunora } from "../src/index";
import { createFixture, packageRoot, removeFixture } from "./fixture";

// What a user waits for before Vite does anything of its own: importing the
// plugin, calling `lunora()`, and running every `config` / `configResolved` hook
// (binding provisioning, the wrangler validator, the cold codegen run, …).
//
// Two shapes:
//
//   - Cold: a fresh process per iteration, the only way to see module-import
//     cost (ESM caches modules per process). Runs the BUILT `dist/` under plain
//     Node, so a TS loader adds nothing — build before benching.
//   - Warm: in-process, modules already loaded — the hooks' own work. `vite
//     build` is measured through `createBuilder`, which resolves the config once
//     for the app and once more per environment (client + worker): each pass
//     runs every hook again, so this is where duplicated startup work shows.
//
// Pure Node; nothing here boots workerd. The cold rows are skipped under
// CI/CodSpeed: its instrumentation does not reach a child process, and that
// job's time budget is better spent on the in-process rows.
const reduced = process.env["CODSPEED_ENV"] !== undefined || process.env["CI"] === "true";
const warmIterations = reduced ? 2 : 10;

const fixture = createFixture("config");
const shim = join(packageRoot, "__bench__", "config-load.shim.mjs");

/** Run the shim; a crash (say, no `dist/`) must fail the row, not time a dead process. */
const runShim = (mode: "import" | "serve"): void => {
    const { status, stderr } = spawnSync(process.execPath, [shim, fixture, mode], { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });

    if (status !== 0) {
        throw new Error(`config-load shim (${mode}) exited ${String(status)} — run \`pnpm run build\` first?\n${stderr}`);
    }
};

const resolveServe = async (): Promise<void> => {
    await resolveConfig({ configFile: false, logLevel: "silent", plugins: [lunora({ projectRoot: fixture })], root: fixture }, "serve");
};

afterAll(() => {
    removeFixture(fixture);
});

describe("config load (cold process: import + lunora() + config hooks)", () => {
    bench.skipIf(reduced)(
        "vite dev config resolution",
        () => {
            runShim("serve");
        },
        { iterations: 8, time: 0, warmupIterations: 1 },
    );

    bench.skipIf(reduced)(
        "import @lunora/vite only",
        () => {
            runShim("import");
        },
        { iterations: 8, time: 0, warmupIterations: 1 },
    );
});

describe("config hooks (warm process)", () => {
    bench(
        "vite dev: resolveConfig(serve)",
        async () => {
            await resolveServe();
        },
        { iterations: warmIterations, time: 0, warmupIterations: 1 },
    );

    bench(
        "vite build: createBuilder (app + per-environment config passes)",
        async () => {
            // An edit between iterations, so each one is a fresh build's config
            // resolution: a build that never starts would otherwise hand the next
            // iteration its unchanged-input startup results.
            appendFileSync(join(fixture, "lunora", "schema.ts"), "\n");

            await createBuilder({ configFile: false, logLevel: "silent", plugins: [lunora({ projectRoot: fixture })], root: fixture });
        },
        { iterations: warmIterations, time: 0, warmupIterations: 1 },
    );
});
