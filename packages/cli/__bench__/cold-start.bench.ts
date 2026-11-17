import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bench, describe } from "vitest";

// Cold-start cost of the built `lunora` bin — what users actually run.
//
// Cold start is only observable across a fresh process boundary (ESM caches
// modules within a process), so each iteration spawns plain node on
// `dist/bin.mjs` and times it end-to-end, next to `node -e 0` as the floor.
//
//   - `--version` should cost about as much as the floor: the bin answers it
//     from package.json before loading the command framework.
//   - `--help` pays for cerebro plus every command's metadata. Command handlers
//     are dynamic imports inside each `execute`, and `@lunora/config/cli` must
//     stay free of codegen/ts-morph (pinned by config's cli-entry-graph test) —
//     either regression shows up here as a jump of 100 ms or more.
//
// COLUMNS/LINES stand in for a TTY: with stdout piped, cerebro otherwise spawns
// `tput` twice to size its help tables, which a real terminal never does.
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const builtBin = join(packageRoot, "dist", "bin.mjs");

if (!existsSync(builtBin)) {
    throw new Error(`cold-start bench needs a built CLI — run \`pnpm --filter @lunora/cli run build:prod\` first (missing ${builtBin})`);
}

const runNode = (arguments_: ReadonlyArray<string>): void => {
    const result = spawnSync(process.execPath, arguments_, { cwd: packageRoot, env: { ...process.env, COLUMNS: "120", LINES: "40" }, stdio: "ignore" });

    if (result.status !== 0) {
        throw new Error(`node ${arguments_.join(" ")} exited ${String(result.status)}`);
    }
};

describe("built lunora bin cold start", () => {
    bench(
        "node -e 0 (floor)",
        () => {
            runNode(["-e", "0"]);
        },
        { iterations: 20, time: 0, warmupIterations: 3 },
    );

    bench(
        "lunora --version",
        () => {
            runNode([builtBin, "--version"]);
        },
        { iterations: 20, time: 0, warmupIterations: 3 },
    );

    bench(
        "lunora --help",
        () => {
            runNode([builtBin, "--help"]);
        },
        { iterations: 20, time: 0, warmupIterations: 3 },
    );
});
