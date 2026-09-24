import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolvedNuxtPlugin } from "../src/module";
import { checkClientOnlyProvider } from "../src/module";

/** The provider body every fixture below writes — what a real `plugins/lunora.ts` does. */
const PROVIDER_SOURCE = "export default defineNuxtPlugin((nuxtApp) => { nuxtApp.vueApp.use(createLunora(new LunoraClient({ url }))); });\n";

/** Write `relativePath` under `<directory>/plugins`, creating intermediate directories, and return its absolute path. */
const writePlugin = (directory: string, relativePath: string, source = PROVIDER_SOURCE): string => {
    const path = join(directory, "plugins", relativePath);

    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, source);

    return path;
};

/**
 * `checkClientOnlyProvider` — the guard behind the module's client-only-plugin
 * warning. Tested directly for the same reason as `checkWorkerEntry`:
 * `defineNuxtModule`'s `setup` needs full Nuxt Kit scaffolding to invoke, so
 * the plain function is the testable seam.
 *
 * The guard consumes Nuxt's OWN resolved plugin list (`app.plugins` at
 * `app:resolve`) — absolute `src` plus the `mode` Nuxt derived — so these
 * fixtures write real files and hand over the entries Nuxt would have built
 * for them. Which files land in that list is Nuxt's business, not this
 * function's, which is exactly the property the previous filesystem scan got
 * wrong.
 */
describe("checkClientOnlyProvider", () => {
    let directory: string;

    afterEach(() => {
        rmSync(directory, { force: true, recursive: true });
    });

    it("warns when the only provider is `plugins/lunora.client.ts` — the defect (a client-only plugin never runs on the server, so SSR has no provider)", () => {
        expect.assertions(3);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));

        const src = writePlugin(directory, "lunora.client.ts");
        const warn = vi.fn<(message: string) => void>();

        checkClientOnlyProvider([{ mode: "client", src }], warn);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toMatch(/only plugin providing a `LunoraClient` is client-only/u);
        expect(warn.mock.calls[0]?.[0]).toContain(src);
    });

    it("names `<ClientOnly>` as the case where a client-only provider is legitimate, so the warning is not a bare defect claim", () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));

        const src = writePlugin(directory, "lunora.client.ts");
        const warn = vi.fn<(message: string) => void>();

        checkClientOnlyProvider([{ mode: "client", src }], warn);

        expect(warn.mock.calls[0]?.[0]).toMatch(/confined to `<ClientOnly>`/u);
    });

    it("is silent for the universal `plugins/lunora.ts` the template ships (no false positive on the fixed shape)", () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));

        const src = writePlugin(directory, "lunora.ts");
        const warn = vi.fn<(message: string) => void>();

        checkClientOnlyProvider([{ mode: "all", src }], warn);

        expect(warn).not.toHaveBeenCalled();
    });

    it("is silent when a universal provider sits alongside a client-only one — SSR is covered, so there is nothing to report", () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));

        const plugins: ResolvedNuxtPlugin[] = [
            { mode: "all", src: writePlugin(directory, "lunora.ts") },
            { mode: "client", src: writePlugin(directory, "extras.client.ts") },
        ];
        const warn = vi.fn<(message: string) => void>();

        checkClientOnlyProvider(plugins, warn);

        expect(warn).not.toHaveBeenCalled();
    });

    it("is silent for a project with no plugins at all", () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));

        const warn = vi.fn<(message: string) => void>();

        checkClientOnlyProvider([], warn);

        expect(warn).not.toHaveBeenCalled();
    });

    it("is silent for client-only plugins that provide no client (only a Lunora provider is the subject of this check)", () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));

        const src = writePlugin(directory, "analytics.client.ts", 'export default defineNuxtPlugin(() => { track("boot"); });\n');
        const warn = vi.fn<(message: string) => void>();

        checkClientOnlyProvider([{ mode: "client", src }], warn);

        expect(warn).not.toHaveBeenCalled();
    });

    it("still warns when a colocated helper under `plugins/` provides the client — `plugins/lib/make-client.ts` is not a plugin, so Nuxt never lists it", () => {
        expect.assertions(2);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));

        const src = writePlugin(directory, "lunora.client.ts");

        // Nuxt's plugin glob is one level deep (`*` plus `*/index`), so this
        // helper is an ordinary module, NOT a universal provider. A recursive
        // filesystem scan counted it as one and suppressed the warning on a
        // genuinely broken app; the resolved list cannot make that mistake.
        writePlugin(directory, "lib/make-client.ts", "export const makeClient = () => createLunora(new LunoraClient({ url }));\n");

        const warn = vi.fn<(message: string) => void>();

        checkClientOnlyProvider([{ mode: "client", src }], warn);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain(src);
    });

    it("treats a `mode`-less entry as universal — `normalizePlugin` only omits it for a plugin object Nuxt has yet to normalise", () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));

        const src = writePlugin(directory, "lunora.ts");
        const warn = vi.fn<(message: string) => void>();

        checkClientOnlyProvider([{ src }], warn);

        expect(warn).not.toHaveBeenCalled();
    });

    it("is silent for a server-only provider — SSR is covered, which is the only failure this guard is about", () => {
        expect.assertions(1);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));

        const src = writePlugin(directory, "lunora.server.ts");
        const warn = vi.fn<(message: string) => void>();

        checkClientOnlyProvider([{ mode: "server", src }], warn);

        expect(warn).not.toHaveBeenCalled();
    });

    it("warns (does not throw) when a plugin file cannot be read — an unreadable file just does not count as a provider", () => {
        expect.assertions(2);

        directory = mkdtempSync(join(tmpdir(), "lunora-nuxt-"));

        const src = writePlugin(directory, "lunora.client.ts");
        // A directory where a file is expected: `readFileSync` raises EISDIR.
        const unreadable = join(directory, "plugins", "broken.ts");

        mkdirSync(unreadable);

        const warn = vi.fn<(message: string) => void>();

        expect(() => {
            checkClientOnlyProvider(
                [
                    { mode: "client", src },
                    { mode: "all", src: unreadable },
                ],
                warn,
            );
        }).not.toThrow();

        expect(warn).toHaveBeenCalledTimes(1);
    });
});
