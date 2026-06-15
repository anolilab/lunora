import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, bench, describe } from "vitest";

// Cold-start cost of `lunora --help`.
//
// Every CLI invocation evaluates the command-module graph at process start.
// The dominant term is ts-morph (pulled by info/migrate), with giget (init)
// and the codegen package (info/migrate/deploy) close behind.
//
// Before the optimization, cli.ts imported all 17 command modules statically,
// so even `lunora --help` / `-v` paid for the full graph — including ts-morph —
// before runCli's fast path ran. After the change the handlers are loaded via
// dynamic import() inside each command's execute, so the help/version/dev/env
// paths never touch ts-morph or giget.
//
// Cold start is only observable across a fresh process boundary (ESM caches
// modules within a process), so each iteration spawns a fresh tsx process
// running a real module file (TLA-capable) and times it end-to-end. Pure Node —
// no workerd. Both arms are identical except for the import strategy, so the
// delta is exactly the deferred heavy-graph evaluation:
//
//   - LAZY  (current): import cli.ts and run --help. With dynamic handler
//     imports, the help path never loads ts-morph / giget.
//   - EAGER (baseline): also evaluate the heavy deps up front (ts-morph +
//     giget) — exactly what the static-import graph forced before.
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const tsxBin = resolve(packageRoot, "..", "..", "node_modules", ".bin", "tsx");
const cliEntry = join(packageRoot, "src", "cli.ts");

// Keep the scratch dir inside the package's node_modules (already gitignored)
// so ts-morph / giget resolve through the package's own node_modules and a
// crashed run can never leak a tracked file.
const cacheRoot = join(packageRoot, "node_modules", ".cache");

mkdirSync(cacheRoot, { recursive: true });

const scratch = mkdtempSync(join(cacheRoot, "lunora-cli-bench-"));

const lazyShim = join(scratch, "lazy.mts");
const eagerShim = join(scratch, "eager.mts");

writeFileSync(
    lazyShim,
    `import { runCli } from ${JSON.stringify(cliEntry)};
await runCli(["--help"]);
`,
    "utf8",
);

writeFileSync(
    eagerShim,
    // Mirror the old static graph: evaluate the heavy deps up front, touching
    // a binding from each so esbuild can't drop the import as dead code.
    `import { Project } from "ts-morph";
import { downloadTemplate } from "giget";
import { runCli } from ${JSON.stringify(cliEntry)};

void (typeof Project + typeof downloadTemplate);
await runCli(["--help"]);
`,
    "utf8",
);

const runShim = (shimPath: string): void => {
    spawnSync(tsxBin, [shimPath], { cwd: packageRoot, stdio: "ignore" });
};

afterAll(() => {
    rmSync(scratch, { force: true, recursive: true });
});

describe("lunora --help cold start", () => {
    bench(
        "lazy command handlers (current — no ts-morph/giget on the help path)",
        () => {
            runShim(lazyShim);
        },
        { iterations: 10, time: 0, warmupIterations: 2 },
    );

    bench(
        "eager command graph (baseline — ts-morph + giget loaded up front)",
        () => {
            runShim(eagerShim);
        },
        { iterations: 10, time: 0, warmupIterations: 2 },
    );
});
