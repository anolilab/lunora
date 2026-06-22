import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, bench, describe } from "vitest";

import { runCodegen } from "../src/index";

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

describe("runCodegen end-to-end (simple fixture)", () => {
    // The cold run is self-contained (fresh workdir per call), so it survives
    // CodSpeed's repeated invocation. The warm run needs a primed workdir set up
    // once — that lives in beforeAll/afterAll rather than the tinybench
    // `setup`/`teardown` options, which CodSpeed's instrumented runner ignores
    // (it would otherwise run against a stale, already-removed workdir).
    let warmWorkdir: string;

    beforeAll(() => {
        warmWorkdir = mkdtempSync(join(tmpdir(), "lunora-codegen-bench-warm-"));
        cpSync(join(fixtureRoot, "lunora"), join(warmWorkdir, "lunora"), { recursive: true });
        // Prime the on-disk output so the bench exercises the `writeIfChanged`
        // no-op path.
        runCodegen({ projectRoot: warmWorkdir });
    });

    afterAll(() => {
        rmSync(warmWorkdir, { force: true, recursive: true });
    });

    bench(
        "cold run — fresh workdir, full project setup",
        () => {
            const coldWorkdir = mkdtempSync(join(tmpdir(), "lunora-codegen-bench-"));

            cpSync(join(fixtureRoot, "lunora"), join(coldWorkdir, "lunora"), { recursive: true });

            try {
                runCodegen({ projectRoot: coldWorkdir });
            } finally {
                rmSync(coldWorkdir, { force: true, recursive: true });
            }
        },
        { iterations: 20 },
    );

    bench(
        "warm run — same workdir, only emit phase changes",
        () => {
            runCodegen({ projectRoot: warmWorkdir });
        },
        { iterations: 20 },
    );
});
