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

/**
 * The composition the module documents: Nitro keeps `fetch`, Lunora gets the
 * event entrypoints. Re-exporting Nitro's `default` instead ships a worker whose
 * `scheduled` only fires an empty `cloudflare:scheduled` hook.
 */
const COMPOSED_TAIL = "export { ShardDO };\nexport default { ...nitro, scheduled: (c, e, x) => app.scheduled(c, e, x) };\n";

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
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));
        writeFileSync(join(directory, "worker.ts"), 'export { default } from "./.output/server/index.mjs";\n');

        const warn = vi.fn<(message: string) => void>();

        checkWorkerEntry(directory, warn);

        expect(warn.mock.calls[0]?.[0]).toMatch(/does not appear to export `ShardDO`/u);
    });

    it("warns when worker.ts re-exports Nitro's default and never forwards `scheduled` — FAILS ON BASELINE (the guard only ever checked ShardDO)", () => {
        expect.assertions(2);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));
        // The shape every Nuxt project shipped: Cloudflare finds a `scheduled`
        // entrypoint (Nitro exports one), calls it successfully, and it fires an
        // empty hook. A cron declared in `lunora/crons.ts` is provisioned by
        // `lunora deploy` and then runs nothing, with no error anywhere.
        writeFileSync(join(directory, "worker.ts"), 'export { default } from "./.output/server/index.mjs";\nexport { ShardDO } from "./lunora/server";\n');

        const warn = vi.fn<(message: string) => void>();

        checkWorkerEntry(directory, warn);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toMatch(/does not forward `scheduled`/u);
    });

    it("is silent for the documented composition (no false positive on a correct file)", () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));
        writeFileSync(
            join(directory, "worker.ts"),
            `import nitro from "./.output/server/index.mjs";\nimport app, { ShardDO } from "./lunora/server";\n${COMPOSED_TAIL}`,
        );

        const warn = vi.fn<(message: string) => void>();

        checkWorkerEntry(directory, warn);

        expect(warn).not.toHaveBeenCalled();
    });

    it('is silent for an `export * from "./lunora/server"` re-export (covers ShardDO without naming it)', () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));
        writeFileSync(join(directory, "worker.ts"), `export * from "./lunora/server";\n${COMPOSED_TAIL}`);

        const warn = vi.fn<(message: string) => void>();

        checkWorkerEntry(directory, warn);

        expect(warn).not.toHaveBeenCalled();
    });

    it("is silent for a local re-export form (`export { ShardDO }`, no specifier)", () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));
        writeFileSync(join(directory, "worker.ts"), `import app, { ShardDO } from "./lunora/server";\n${COMPOSED_TAIL}`);

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

    it("warns when only a COMMENT mentions ShardDO and `scheduled` — the shape the shipped template makes likely", () => {
        expect.assertions(2);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));
        // `templates/nuxt/worker.ts` carries a 30-line header explaining that
        // both the `ShardDO` export and the `scheduled` forwarding are
        // load-bearing. Delete the lines, keep the header, and a probe over the
        // raw file reads the explanation as the wiring — silence for a worker
        // that deploys without its Durable Object and runs no cron.
        writeFileSync(
            join(directory, "worker.ts"),
            `/**\n * Re-exports ShardDO and forwards scheduled — both load-bearing.\n */\nexport { default } from "./.output/server/index.mjs";\n`,
        );

        const warn = vi.fn<(message: string) => void>();

        checkWorkerEntry(directory, warn);

        expect(warn.mock.calls[0]?.[0]).toMatch(/does not appear to export `ShardDO`/u);
        expect(warn.mock.calls[1]?.[0]).toMatch(/does not forward `scheduled`/u);
    });

    it('is silent for a `export * from "./lunora/server"` whose specifier survives comment-blanking', () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));
        // The star-export probe reads the SPECIFIER, so it runs over source with
        // comments blanked and strings intact — blanking strings too would erase
        // the very thing it matches on.
        // No `ShardDO` identifier anywhere, so the star-export branch is the
        // only thing that can clear the check.
        writeFileSync(
            join(directory, "worker.ts"),
            '// the barrel below carries the Durable Object class\nexport * from "./lunora/server";\nexport default { ...nitro, scheduled: (c, e, x) => app.scheduled(c, e, x) };\n',
        );

        const warn = vi.fn<(message: string) => void>();

        checkWorkerEntry(directory, warn);

        expect(warn).not.toHaveBeenCalled();
    });

    it("warns when a STRING LITERAL — not the file — carries the star export", () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));
        // The star-export probe keeps string literals so it can read the
        // specifier, which is exactly what lets a snippet held in a string pass
        // for the wiring. A scaffolder that prints the line it wants the user to
        // add exports no `ShardDO` itself.
        writeFileSync(
            join(directory, "worker.ts"),
            `export const hint = 'add export * from "./lunora/server" to worker.ts';\nexport default { ...nitro, scheduled: (c, e, x) => app.scheduled(c, e, x) };\n`,
        );

        const warn = vi.fn<(message: string) => void>();

        checkWorkerEntry(directory, warn);

        expect(warn.mock.calls[0]?.[0]).toMatch(/does not appear to export `ShardDO`/u);
    });

    it("is silent when a real star export follows one quoted in a string (every match is considered, not just the first)", () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));
        writeFileSync(
            join(directory, "worker.ts"),
            `export const hint = 'add export * from "./lunora/server" to worker.ts';\nexport * from "./lunora/server";\nexport default { ...nitro, scheduled: (c, e, x) => app.scheduled(c, e, x) };\n`,
        );

        const warn = vi.fn<(message: string) => void>();

        checkWorkerEntry(directory, warn);

        expect(warn).not.toHaveBeenCalled();
    });
});
