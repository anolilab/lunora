import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

/**
 * How `loadEmailDomainLists` loads, rather than what it classifies.
 *
 * Two failure modes live here and neither is visible to the rest of the suite.
 *
 * Vite (and wrangler's esbuild) INLINE a `.json` dynamic import, so the bundled
 * build never exercises native ESM's JSON rules. The published
 * `dist/email-guard.mjs` does — and a bare `import()` of a `.json` module throws
 * `ERR_IMPORT_ATTRIBUTE_MISSING` there, turning every signup into a 500. The
 * first test therefore re-runs the module's own import specifiers under a real
 * `node` process, outside any bundler.
 *
 * The load is also memoised with `??=`, which caches a REJECTED promise for the
 * isolate's life. One transient failure would brick the gate permanently.
 */

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));

describe("loadEmailDomainLists — module loading", () => {
    it("imports its domain lists in a form native ESM accepts", () => {
        expect.assertions(2);

        // Read the specifiers off the source instead of restating them, so a future
        // edit that drops the import attribute is caught here rather than in prod.
        const source = readFileSync(new URL("../src/email-guard.ts", import.meta.url), "utf8");
        const specifiers = [...source.matchAll(/import\((\s*"@visulima\/[\w-]*email-domains\/domains"[^)]*)\)/g)].map((match) => match[1] ?? "");

        // Pinned BEFORE the spawn, because an empty script body is a `node` exit
        // 0: a rename, a move to a variable or a reformat that stops the pattern
        // matching would leave this test passing having imported nothing, and it
        // is the only guard the package has against the published-bundle ESM
        // failure described above.
        expect(specifiers).toHaveLength(2);

        expect(() =>
            execFileSync(
                process.execPath,
                [
                    "--input-type=module",
                    "-e",
                    // Awaiting each import is the whole check: a JSON module without an
                    // import attribute throws on resolution, before any list is read.
                    specifiers.map((specifier) => `await import(${specifier});`).join("\n"),
                ],
                { cwd: packageDirectory, stdio: "pipe" },
            ),
        ).not.toThrow();
    });

    it("retries after a failed load instead of memoising the rejection forever", async () => {
        expect.assertions(3);

        let attempts = 0;

        vi.doMock(import("@visulima/free-email-domains"), async (importOriginal) => {
            const actual = await importOriginal();

            return {
                ...actual,
                setDomains: (domains: ReadonlyArray<string>) => {
                    attempts += 1;

                    if (attempts === 1) {
                        throw new Error("transient list injection failure");
                    }

                    actual.setDomains([...domains]);
                },
            };
        });

        const { classifyEmail, loadEmailDomainLists } = await import("../src/email-guard");

        await expect(loadEmailDomainLists()).rejects.toThrow("transient list injection failure");

        // The second call must run the load again. Replaying the cached rejection
        // would leave `emailGateMiddleware` answering 500 until the isolate recycles.
        await expect(loadEmailDomainLists()).resolves.toBeUndefined();
        expect(classifyEmail("user@gmail.com").emailClass).toBe("free");

        vi.doUnmock("@visulima/free-email-domains");
        vi.resetModules();
    });
});
