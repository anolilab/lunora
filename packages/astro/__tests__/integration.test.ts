import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { lunora } from "../src/integration";

/** Minimal fake of the `astro:config:done` hook payload, scoped to what the hook reads. */
interface ConfigDoneHookArgument {
    config: { root: URL };
    logger: { warn: (message: string) => void };
}

describe("lunora() Astro integration", () => {
    it("returns an AstroIntegration object with the package name", () => {
        expect.assertions(2);

        const integration = lunora();

        expect(integration.name).toBe("@lunora/astro");
        expect(typeof integration.hooks).toBe("object");
    });

    it("exposes an astro:config:done hook that runs without side effects when no context is passed", () => {
        expect.assertions(1);

        const integration = lunora({ serverEntry: "src/custom-worker.ts" });
        const hook = integration.hooks["astro:config:done"];

        // Without a `config.root` to resolve against (e.g. a caller invoking the
        // hook directly, as this test does), there is nothing to check the entry
        // file against — the hook must stay side-effect-free rather than throw.
        expect(() => {
            (hook as () => void)();
        }).not.toThrow();
    });

    describe("serverEntry existence + withLunora check", () => {
        let directory: string;

        afterEach(() => {
            rmSync(directory, { force: true, recursive: true });
        });

        const contextFor = (root: string, warn = vi.fn<(message: string) => void>()): ConfigDoneHookArgument => {
            return { config: { root: pathToFileURL(`${root}/`) }, logger: { warn } };
        };

        it("warns when serverEntry does not exist", () => {
            expect.assertions(2);

            directory = mkdtempSync(join(tmpdir(), "lunora-astro-"));

            const warn = vi.fn<(message: string) => void>();
            const integration = lunora({ serverEntry: "src/worker.ts" });
            const hook = integration.hooks["astro:config:done"] as (context: ConfigDoneHookArgument) => void;

            hook(contextFor(directory, warn));

            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0]?.[0]).toMatch(/server entry "src\/worker\.ts" not found/u);
        });

        it("falls back to console.warn when the caller supplies no logger at all", () => {
            expect.assertions(2);

            // Real Astro always passes a logger; this covers a caller invoking
            // the hook directly without one (`logger` is optional on
            // `ConfigDoneContext`) — and, more importantly, that the fallback
            // itself is reachable: `context.logger?.warn` is only ever tested
            // elsewhere with a logger present, so this branch of `warn` had no
            // coverage at all.
            directory = mkdtempSync(join(tmpdir(), "lunora-astro-"));

            const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
            const integration = lunora({ serverEntry: "src/worker.ts" });
            const hook = integration.hooks["astro:config:done"] as (context: { config: { root: URL } }) => void;

            hook({ config: { root: pathToFileURL(`${directory}/`) } });

            expect(consoleWarn).toHaveBeenCalledTimes(1);
            expect(consoleWarn.mock.calls[0]?.[0]).toMatch(/server entry "src\/worker\.ts" not found/u);

            consoleWarn.mockRestore();
        });

        it("warns when serverEntry exists but does not call withLunora", () => {
            expect.assertions(2);

            directory = mkdtempSync(join(tmpdir(), "lunora-astro-"));
            writeFileSync(join(directory, "worker.ts"), "export default { fetch: () => new Response('ok') };\n");

            const warn = vi.fn<(message: string) => void>();
            const integration = lunora({ serverEntry: "worker.ts" });
            const hook = integration.hooks["astro:config:done"] as (context: ConfigDoneHookArgument) => void;

            hook(contextFor(directory, warn));

            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0]?.[0]).toMatch(/couldn't find a `withLunora\(\.\.\.\)` or `\.buildFrameworkWorker\(\.\.\.\)` call/u);
        });

        it("is silent when serverEntry exists and calls withLunora", () => {
            expect.assertions(1);

            directory = mkdtempSync(join(tmpdir(), "lunora-astro-"));
            writeFileSync(
                join(directory, "worker.ts"),
                'import { withLunora } from "@lunora/astro";\nexport default withLunora(astroWorker, (env) => ({ shardDO: env.SHARD }));\n',
            );

            const warn = vi.fn<(message: string) => void>();
            const integration = lunora({ serverEntry: "worker.ts" });
            const hook = integration.hooks["astro:config:done"] as (context: ConfigDoneHookArgument) => void;

            hook(contextFor(directory, warn));

            expect(warn).not.toHaveBeenCalled();
        });

        it("is silent when serverEntry composes with the generated builder's .buildFrameworkWorker()", () => {
            expect.assertions(1);

            // The scaffolded template — and every other class-B template — composes
            // with `defineApp().…buildFrameworkWorker(host)`, not the standalone
            // `withLunora` helper. Recognising only `withLunora(` made a correctly
            // composed worker warn "subscriptions will silently 404" on every build.
            directory = mkdtempSync(join(tmpdir(), "lunora-astro-"));
            writeFileSync(
                join(directory, "worker.ts"),
                'import { handle } from "@astrojs/cloudflare/handler";\nconst app = defineApp().shard((env) => env.SHARD).buildFrameworkWorker(handle);\nexport default app;\n',
            );

            const warn = vi.fn<(message: string) => void>();
            const integration = lunora({ serverEntry: "worker.ts" });
            const hook = integration.hooks["astro:config:done"] as (context: ConfigDoneHookArgument) => void;

            hook(contextFor(directory, warn));

            expect(warn).not.toHaveBeenCalled();
        });

        it("warns when serverEntry imports withLunora but never calls it", () => {
            expect.assertions(2);

            // Regression: `source.includes("withLunora")` was always true here
            // because the import specifier itself contains the substring — the
            // guard must look for an actual `withLunora(...)` call, not mere
            // presence of the identifier.
            directory = mkdtempSync(join(tmpdir(), "lunora-astro-"));
            writeFileSync(join(directory, "worker.ts"), 'import { withLunora } from "@lunora/astro";\nexport default astroWorker;\n');

            const warn = vi.fn<(message: string) => void>();
            const integration = lunora({ serverEntry: "worker.ts" });
            const hook = integration.hooks["astro:config:done"] as (context: ConfigDoneHookArgument) => void;

            hook(contextFor(directory, warn));

            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0]?.[0]).toMatch(/couldn't find a `withLunora\(\.\.\.\)` or `\.buildFrameworkWorker\(\.\.\.\)` call/u);
        });

        it("prints a wiring snippet that actually resolves and runs", () => {
            expect.assertions(4);

            // Regression: the snippet told the user to import `withLunora` from
            // `@lunora/astro/server` — which only re-exports `@lunora/client/ssr`, so
            // the import is unresolved — and wrote `env.SHARD` at module top level
            // where `env` is not in scope, a `ReferenceError`. The remedy for the
            // warning was itself two errors.
            directory = mkdtempSync(join(tmpdir(), "lunora-astro-"));
            writeFileSync(join(directory, "worker.ts"), "export default astroWorker;\n");

            const warn = vi.fn<(message: string) => void>();
            const integration = lunora({ serverEntry: "worker.ts" });
            const hook = integration.hooks["astro:config:done"] as (context: ConfigDoneHookArgument) => void;

            hook(contextFor(directory, warn));

            const message = warn.mock.calls[0]?.[0] ?? "";

            expect(message).toContain('from "@lunora/astro"');
            expect(message).not.toContain("@lunora/astro/server");
            // `env` is only ever reached through the `(env) => options` factory …
            expect(message).toContain("(env) => ({ shardDO: env.SHARD");
            // … never as a bare top-level reference.
            expect(message).not.toMatch(/^export default withLunora\(astroWorker, \{ shardDO: env\./mu);
        });

        it("warns (does not throw) when serverEntry exists but cannot be read", () => {
            expect.assertions(2);

            // `existsSync` passing doesn't mean `readFileSync` will succeed — a
            // directory at that path raises EISDIR. The hook's contract is "warns,
            // does not fail the build", so this must degrade to a warning too.
            directory = mkdtempSync(join(tmpdir(), "lunora-astro-"));
            mkdirSync(join(directory, "worker.ts"));

            const warn = vi.fn<(message: string) => void>();
            const integration = lunora({ serverEntry: "worker.ts" });
            const hook = integration.hooks["astro:config:done"] as (context: ConfigDoneHookArgument) => void;

            expect(() => {
                hook(contextFor(directory, warn));
            }).not.toThrow();

            expect(warn.mock.calls[0]?.[0]).toMatch(/could not read server entry/u);
        });
    });

    it("defaults serverEntry without requiring options", () => {
        expect.assertions(1);

        // Constructing with no args must not throw and must still yield hooks.
        expect(() => lunora()).not.toThrow();
    });

    it("accepts construction with an empty serverEntry but rejects it when the hook runs", () => {
        expect.assertions(2);

        // `??` only substitutes the default for null/undefined, so an explicit
        // empty string survives and must be caught by the hook's guard rather
        // than silently composing a worker against an unresolvable entry.
        const integration = lunora({ serverEntry: "" });

        expect(() => integration).not.toThrow();

        const hook = integration.hooks["astro:config:done"];

        expect(() => {
            (hook as () => void)();
        }).toThrow(/serverEntry/);
    });

    it("rejects a whitespace-only serverEntry when the hook runs", () => {
        expect.assertions(1);

        // A whitespace-only path is just as unresolvable as an empty string;
        // the guard trims before the emptiness check so it is caught too.
        const integration = lunora({ serverEntry: "   " });
        const hook = integration.hooks["astro:config:done"];

        expect(() => {
            (hook as () => void)();
        }).toThrow(/serverEntry/);
    });
});
