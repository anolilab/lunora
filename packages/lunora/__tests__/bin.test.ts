import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const binPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.mjs");

// The bin is the one piece of the umbrella that is not a re-export: it owns the
// `lunora` command and delegates to @lunora/cli's runCli. Run the built entry
// for real — a broken import chain or a missing await would fail here first.
describe("lunora bin (dist/bin.mjs)", () => {
    it("runs the delegated CLI and exits 0 for --version", async () => {
        const { stdout } = await execFileAsync(process.execPath, [binPath, "--version"], { timeout: 60_000 });

        expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    }, 70_000);

    it("exits non-zero for an unknown command instead of swallowing the failure", async () => {
        const result = await execFileAsync(process.execPath, [binPath, "definitely-not-a-lunora-command"], { timeout: 60_000 }).then(
            () => undefined,
            (error: unknown) => error as { code?: number },
        );

        expect(result?.code).toBeGreaterThan(0);
    }, 70_000);
});
