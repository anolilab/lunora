import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { checkClientOnlyProvider } from "../src/module";

/** The provider body every fixture below writes — what a real `plugins/lunora.ts` does. */
const PROVIDER_SOURCE = "export default defineNuxtPlugin((nuxtApp) => { nuxtApp.vueApp.use(createLunora(new LunoraClient({ url }))); });\n";

/** Write `relativePath` under `<srcDirectory>/plugins`, creating intermediate directories. */
const writePlugin = (srcDirectory: string, relativePath: string, source = PROVIDER_SOURCE): void => {
    const path = join(srcDirectory, "plugins", relativePath);

    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, source);
};

/**
 * `checkClientOnlyProvider` — the guard behind the module's client-only-plugin
 * warning. Tested directly for the same reason as `checkWorkerEntry`:
 * `defineNuxtModule`'s `setup` needs full Nuxt Kit scaffolding to invoke, so
 * the plain function is the testable seam.
 */
describe("checkClientOnlyProvider", () => {
    let directory: string;

    afterEach(() => {
        rmSync(directory, { force: true, recursive: true });
    });

    it("warns when the only provider is `plugins/lunora.client.ts` — the defect (a client-only plugin never runs on the server, so SSR has no provider)", () => {
        expect.assertions(3);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));
        writePlugin(directory, "lunora.client.ts");

        const warn = vi.fn<(message: string) => void>();

        checkClientOnlyProvider(directory, warn);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toMatch(/only plugin providing a `LunoraClient` is client-only/u);
        expect(warn.mock.calls[0]?.[0]).toMatch(/plugins\/lunora\.client\.ts/u);
    });

    it("is silent for the universal `plugins/lunora.ts` the template ships (no false positive on the fixed shape)", () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));
        writePlugin(directory, "lunora.ts");

        const warn = vi.fn<(message: string) => void>();

        checkClientOnlyProvider(directory, warn);

        expect(warn).not.toHaveBeenCalled();
    });

    it("is silent when a universal provider sits alongside a client-only one — SSR is covered, so there is nothing to report", () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));
        writePlugin(directory, "lunora.ts");
        writePlugin(directory, "extras.client.ts");

        const warn = vi.fn<(message: string) => void>();

        checkClientOnlyProvider(directory, warn);

        expect(warn).not.toHaveBeenCalled();
    });

    it("is silent for a project with no `plugins/` directory at all", () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));

        const warn = vi.fn<(message: string) => void>();

        checkClientOnlyProvider(directory, warn);

        expect(warn).not.toHaveBeenCalled();
    });

    it("is silent for client-only plugins that provide no client (only a Lunora provider is the subject of this check)", () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));
        writePlugin(directory, "analytics.client.ts", 'export default defineNuxtPlugin(() => { track("boot"); });\n');

        const warn = vi.fn<(message: string) => void>();

        checkClientOnlyProvider(directory, warn);

        expect(warn).not.toHaveBeenCalled();
    });

    it("finds a nested plugin (`plugins/lunora/index.client.ts`) — Nuxt loads those too, so the scan is recursive", () => {
        expect.assertions(2);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));
        writePlugin(directory, "lunora/index.client.ts");

        const warn = vi.fn<(message: string) => void>();

        checkClientOnlyProvider(directory, warn);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toMatch(/plugins\/lunora\/index\.client\.ts/u);
    });

    it("covers the `.client.mts` extension variant Nuxt also loads client-side", () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));
        writePlugin(directory, "lunora.client.mts");

        const warn = vi.fn<(message: string) => void>();

        checkClientOnlyProvider(directory, warn);

        expect(warn).toHaveBeenCalledTimes(1);
    });

    it("warns (does not throw) when a plugin file cannot be read — an unreadable file just does not count as a provider", () => {
        expect.assertions(2);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));
        writePlugin(directory, "lunora.client.ts");
        // `readdirSync` lists it, `readFileSync` raises EISDIR.
        mkdirSync(join(directory, "plugins", "broken.ts"));

        const warn = vi.fn<(message: string) => void>();

        expect(() => {
            checkClientOnlyProvider(directory, warn);
        }).not.toThrow();

        expect(warn).toHaveBeenCalledTimes(1);
    });
});
