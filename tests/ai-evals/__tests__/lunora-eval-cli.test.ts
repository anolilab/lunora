import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

/**
 * Absolute path to the CLI's built `lunora` bin, read off `@lunora/cli`'s own
 * manifest rather than hard-coded, so a moved entrypoint fails here instead of
 * silently testing nothing.
 */
const lunoraBin = (): string => {
    const manifestPath = fileURLToPath(import.meta.resolve("@lunora/cli/package.json"));
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin?: Record<string, string> };
    const relative = manifest.bin?.["lunora"];

    if (relative === undefined) {
        throw new Error("@lunora/cli declares no `lunora` bin");
    }

    return join(dirname(manifestPath), relative);
};

interface EvalJson {
    code: number;
    evals: { average?: number; items?: unknown[]; name?: string; passed?: boolean }[];
}

/**
 * The only honest seam for this behaviour.
 *
 * Vitest transforms and resolves any `.ts` it is handed, including one reached
 * through a runtime `import()` — so a `runEvalCommand` unit test passes whether
 * or not the command can load an eval file, which is exactly how the bug
 * survived. Proving it needs the shipped binary on plain Node, where nothing
 * else is transforming anything, so this test shells out to it.
 *
 * `ai-chat.eval.ts` is the subject on purpose: it imports `../../shared/ai-chat`,
 * which imports `./sql-readonly` — the extension-less relative import every
 * Lunora project writes under `moduleResolution: "bundler"`, and the exact hop
 * a bare `import()` dies on.
 */
describe("lunora eval (built binary, plain Node)", () => {
    it("loads and runs an eval file that imports project source through extension-less relative imports", async () => {
        expect.assertions(5);

        const binary = lunoraBin();

        // A missing build is a failure, not a skip: a skipped gate is a green
        // gate that proves nothing. Upstream `@lunora/*` builds are what the
        // vis `test` target's `dependsOn: ["^build"]` arranges.
        expect(existsSync(binary)).toBe(true);

        const { stdout } = await execFileAsync(process.execPath, [binary, "eval", "--dir", "tests/ai-evals", "--format", "json"], {
            cwd: repoRoot,
            maxBuffer: 32 * 1024 * 1024,
        });

        const parsed = JSON.parse(stdout) as EvalJson;

        expect(parsed.code).toBe(0);
        expect(parsed.evals).toHaveLength(1);
        expect(parsed.evals[0]?.name).toBe("studio-ai-chat");
        // Every case is a behavioural invariant, so the set's own `threshold: 1`
        // is what `passed` was decided against.
        expect(parsed.evals[0]?.passed).toBe(true);
    }, 120_000);
});
