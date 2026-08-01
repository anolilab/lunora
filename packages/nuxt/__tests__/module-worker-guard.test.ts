import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { checkWorkerEntry } from "../src/module";

/**
 * `checkWorkerEntry` — the guard behind the module's `worker.ts` warning
 * (plan 281). Extracted from `setup()` and tested directly here, mirroring
 * `@lunora/astro`'s `astro:config:done` hook tests: `defineNuxtModule`'s
 * `setup` needs full Nuxt Kit scaffolding to invoke (unlike Astro's
 * plain-object integration hooks), so this plain function is the testable
 * seam instead.
 */
describe("checkWorkerEntry", () => {
    let directory: string;

    afterEach(() => {
        rmSync(directory, { force: true, recursive: true });
    });

    it("warns when worker.ts does not exist (fails on baseline: the old guard never checked content, but a MISSING file already warned there too — this case alone doesn't distinguish old from new)", () => {
        expect.assertions(2);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));

        const warn = vi.fn<(message: string) => void>();

        checkWorkerEntry(directory, warn);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toMatch(/missing worker\.ts at the project root/u);
    });

    it("warns when worker.ts exists but only re-exports the Nitro handler (no ShardDO) — FAILS ON BASELINE (the old presence-only guard stayed silent)", () => {
        expect.assertions(2);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));
        writeFileSync(join(directory, "worker.ts"), 'export { default } from "./.output/server/index.mjs";\n');

        const warn = vi.fn<(message: string) => void>();

        checkWorkerEntry(directory, warn);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toMatch(/does not appear to export `ShardDO`/u);
    });

    it("is silent when worker.ts has the documented two-line snippet (no false positive on a correct file)", () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));
        writeFileSync(join(directory, "worker.ts"), 'export { default } from "./.output/server/index.mjs";\nexport { ShardDO } from "./lunora/server";\n');

        const warn = vi.fn<(message: string) => void>();

        checkWorkerEntry(directory, warn);

        expect(warn).not.toHaveBeenCalled();
    });

    it('is silent for an `export * from "./lunora/server"` re-export (covers ShardDO without naming it)', () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));
        writeFileSync(join(directory, "worker.ts"), 'export { default } from "./.output/server/index.mjs";\nexport * from "./lunora/server";\n');

        const warn = vi.fn<(message: string) => void>();

        checkWorkerEntry(directory, warn);

        expect(warn).not.toHaveBeenCalled();
    });

    it("is silent for a local re-export form (`export { ShardDO }`, no specifier)", () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));
        writeFileSync(
            join(directory, "worker.ts"),
            'import { ShardDO } from "./lunora/server";\nexport { default } from "./.output/server/index.mjs";\nexport { ShardDO };\n',
        );

        const warn = vi.fn<(message: string) => void>();

        checkWorkerEntry(directory, warn);

        expect(warn).not.toHaveBeenCalled();
    });

    it('warns (does not throw) when worker.ts exists but cannot be read — FAILS ON BASELINE (the old guard treated a directory named worker.ts as "present" and stayed silent)', () => {
        expect.assertions(3);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));
        // `existsSync` passing doesn't mean `readFileSync` will succeed — a
        // directory at that path raises EISDIR.
        mkdirSync(join(directory, "worker.ts"));

        const warn = vi.fn<(message: string) => void>();

        expect(() => {
            checkWorkerEntry(directory, warn);
        }).not.toThrow();

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toMatch(/could not read worker\.ts/u);
    });

    it("known false positive (documented on looksLikeShardDoExport): a `ShardDO` mention inside a comment, anywhere in a file that also has a real `export`, silences the warning", () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));
        // The guard checks "has an export keyword" and "mentions ShardDO"
        // independently, anywhere in the file — it does not verify ShardDO
        // sits inside an actual export statement. A comment mentioning ShardDO,
        // in a file that separately exports something else entirely, is
        // indistinguishable from a real `export { ShardDO }`. This is the
        // documented imprecision, not a regression; a real TS parse would not
        // have this gap, which is exactly the tradeoff the pattern's docblock
        // calls out (a build-time warning hook doesn't warrant one).
        writeFileSync(join(directory, "worker.ts"), '// TODO: remember to export ShardDO from here\nexport { default } from "./.output/server/index.mjs";\n');

        const warn = vi.fn<(message: string) => void>();

        checkWorkerEntry(directory, warn);

        expect(warn).not.toHaveBeenCalled();
    });
});
