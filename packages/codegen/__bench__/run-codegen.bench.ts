import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { bench, describe } from "vitest";

import { runCodegen } from "../src/index.js";

/**
 * Codegen runs on every schema/function file save in dev. The Vite plugin's
 * HMR budget is roughly 200 ms end-to-end — codegen is a non-trivial slice
 * of that. This bench captures full-pipeline cost on the canonical fixture
 * (schema + one function file) so regressions in ts-morph project setup,
 * AST walking, or emit show up immediately.
 *
 * We rebuild the workdir per iteration because `runCodegen` writes
 * `_generated/*.ts` files into the tree and uses `writeIfChanged` — without
 * fresh state the first run dominates and the steady state isn't measured.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "__tests__", "fixtures", "simple");

let workdir: string;

describe("runCodegen end-to-end (simple fixture)", () => {
    bench(
        "cold run — fresh workdir, full project setup",
        () => {
            workdir = mkdtempSync(join(tmpdir(), "cirrus-codegen-bench-"));
            cpSync(join(fixtureRoot, "cirrus"), join(workdir, "cirrus"), { recursive: true });

            try {
                runCodegen({ projectRoot: workdir });
            } finally {
                rmSync(workdir, { force: true, recursive: true });
            }
        },
        { iterations: 20 },
    );

    bench(
        "warm run — same workdir, only emit phase changes",
        () => {
            runCodegen({ projectRoot: workdir });
        },
        {
            iterations: 20,
            setup: () => {
                workdir = mkdtempSync(join(tmpdir(), "cirrus-codegen-bench-warm-"));
                cpSync(join(fixtureRoot, "cirrus"), join(workdir, "cirrus"), { recursive: true });
                // Prime the on-disk output so the second pass exercises the
                // `writeIfChanged` no-op path.
                runCodegen({ projectRoot: workdir });
            },
            teardown: () => {
                rmSync(workdir, { force: true, recursive: true });
            },
        },
    );
});
