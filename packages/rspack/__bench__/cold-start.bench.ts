import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, bench, describe } from "vitest";

import createBenchProject from "./fixture";

// Cold-start cost of the plugin: evaluating the module graph behind
// `@lunora/rspack` / `@lunora/rspack/rsbuild` and constructing the plugin, which
// is what every `rspack` / `rsbuild` command pays while loading its config.
//
// Only observable across a fresh process boundary (ESM caches modules within a
// process), so each iteration spawns `node` on a shim importing the BUILT dist —
// run `pnpm --filter "@lunora/rspack..." run build` first. The baseline arm is a
// bare `node` start, so the delta is what this package costs.
const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "..", "dist");
const root = createBenchProject(0);

const shim = (name: string, source: string): string => {
    const path = join(root, name);

    writeFileSync(path, source, "utf8");

    return path;
};

const baselineShim = shim("baseline.mjs", "");
const rspackShim = shim(
    "rspack.mjs",
    `import { lunoraRspack } from ${JSON.stringify(join(dist, "index.mjs"))};
lunoraRspack({ projectRoot: ${JSON.stringify(root)} });
`,
);
const rsbuildShim = shim(
    "rsbuild.mjs",
    `import { lunoraRsbuild } from ${JSON.stringify(join(dist, "rsbuild.mjs"))};
lunoraRsbuild({ projectRoot: ${JSON.stringify(root)} });
`,
);

const run = (path: string): void => {
    const result = spawnSync(process.execPath, [path], { cwd: root, encoding: "utf8" });

    if (result.status !== 0) {
        throw new Error(`${path} exited ${String(result.status)}: ${result.stderr}`);
    }
};

afterAll(() => {
    rmSync(root, { force: true, recursive: true });
});

describe("plugin cold start (fresh node process)", () => {
    // Shrunk under CodSpeed (`CODSPEED_ENV`, or `CI`), whose instrumented run is 50-100x slower.
    const reduced = process.env["CODSPEED_ENV"] !== undefined || process.env["CI"] === "true";
    const options = { iterations: reduced ? 3 : 10, time: 0, warmupIterations: reduced ? 1 : 2 };

    bench(
        "baseline: bare node start",
        () => {
            run(baselineShim);
        },
        options,
    );

    bench(
        "import @lunora/rspack + lunoraRspack()",
        () => {
            run(rspackShim);
        },
        options,
    );

    bench(
        "import @lunora/rspack/rsbuild + lunoraRsbuild()",
        () => {
            run(rsbuildShim);
        },
        options,
    );
});
