import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { bench, describe } from "vitest";

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

let warmWorkdir: string | undefined;

/**
 * A workdir with `_generated/*` already written, created on first use.
 *
 * Neither of the two obvious places for this works under the instrumented
 * runner. tinybench's `setup`/`teardown` options are ignored by it outright;
 * `beforeAll` runs in a DIFFERENT context from the bench bodies, so the variable
 * it assigns reads back `undefined` inside them.
 *
 * That second failure is why this bench measured nothing at all. The warm body
 * threw `The "path" argument must be of type string` on every iteration — and a
 * bench that throws takes the whole FILE's samples with it, silently and with a
 * zero exit, so the cold run reported nothing either and the summary printed
 * `NaNx faster than`. CodSpeed was tracking a number that was never measured.
 *
 * Lazily initialising on first call sidesteps both: it runs in whichever context
 * the bench body runs in, and it primes exactly once per context.
 * @returns the primed workdir path
 */
const primedWorkdir = (): string => {
    warmWorkdir ??= (() => {
        const created = mkdtempSync(join(tmpdir(), "lunora-codegen-bench-warm-"));

        cpSync(join(fixtureRoot, "lunora"), join(created, "lunora"), { recursive: true });
        // Prime the on-disk output so the bench exercises the `writeIfChanged`
        // no-op path rather than a first write.
        runCodegen({ projectRoot: created });

        return created;
    })();

    return warmWorkdir;
};

// Cleaned on process exit rather than in `afterAll`, which cannot see the value
// for the same context reason. The directory is small and lives in the OS temp
// dir, so a missed cleanup after a hard kill is harmless.
process.on("exit", () => {
    if (warmWorkdir !== undefined) {
        rmSync(warmWorkdir, { force: true, recursive: true });
    }
});

describe("runCodegen end-to-end (simple fixture)", () => {
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
            runCodegen({ projectRoot: primedWorkdir() });
        },
        { iterations: 20 },
    );
});
