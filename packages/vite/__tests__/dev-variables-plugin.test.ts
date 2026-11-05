import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DevEnvCheck } from "@lunora/config";
import { checkDevEnv } from "@lunora/config";
import type { Plugin, ViteDevServer } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import devVariablesPlugin from "../src/dev-variables-plugin";
import { lunora } from "../src/index";

// A test that needs a check to finish out of order replaces one run; every other run is the real check.
vi.mock(import("@lunora/config"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, checkDevEnv: vi.fn<typeof actual.checkDevEnv>(actual.checkDevEnv) };
});

const RESOLVED = (projectRoot: string) => {
    return {
        allowUnauthenticatedShardAccess: false as const,
        apiSpec: "openapi" as const,
        lazyFunctions: false,
        cloudflare: {} as never,
        generatedDir: "lunora/_generated",
        overlay: false as const,
        projectRoot,
        schemaDir: "lunora",
        shard: {},
        target: "cloudflare",
        studio: true,
        validateWrangler: false,
    };
};

/**
 * Drive the plugin through Vite's hook order — `config` (the only place
 * `isPreview` is exposed), then `configResolved` (where it acts).
 */
const runHooks = async (plugin: Plugin, isPreview = false): Promise<void> => {
    const configHook = plugin.config;
    const configFunction = typeof configHook === "function" ? configHook : configHook?.handler;

    (configFunction as (userConfig: unknown, environment: { command: string; isPreview: boolean }) => void).call(
        plugin,
        {},
        {
            command: "serve",
            isPreview,
        },
    );

    const hook = plugin.configResolved;
    const resolvedHook = typeof hook === "function" ? hook : hook?.handler;

    await (resolvedHook as (config: unknown) => Promise<void>).call(plugin, {});
};

describe("devVariablesPlugin", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "lunora-vite-devvars-"));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        rmSync(dir, { force: true, recursive: true });
    });

    it("is a pre-enforced, serve-only plugin", () => {
        expect.assertions(3);

        const plugin = devVariablesPlugin(RESOLVED(dir));

        expect(plugin.name).toBe("lunora:dev-vars");
        expect(plugin.enforce).toBe("pre");
        expect(plugin.apply).toBe("serve");
    });

    it("does not scaffold the example's secrets without a prompt, but still ensures the admin token", async () => {
        expect.assertions(2);

        writeFileSync(join(dir, ".dev.vars.example"), 'AUTH_SECRET="replace-me-openssl"\n', "utf8");
        // stdin is not a TTY in the test runner → ensureDevVariables's confirm
        // resolves false → the example's AUTH_SECRET is NOT scaffolded. But
        // fillDevSecrets still ensures the (locally-generated) admin token, since
        // the Studio needs it and there's nothing to prompt about.
        await runHooks(devVariablesPlugin(RESOLVED(dir)));

        const content = existsSync(join(dir, ".dev.vars")) ? readFileSync(join(dir, ".dev.vars"), "utf8") : "";

        expect(content).toContain("LUNORA_ADMIN_TOKEN=");
        // The example secret stays unscaffolded — it needs the (declined) prompt.
        expect(content).not.toContain("AUTH_SECRET=");
    });

    it("warns once and keeps the dev server starting when .dev.vars is a directory", async () => {
        expect.assertions(2);

        // No example: `fillDevSecrets` read the directory anyway and threw EISDIR out of `configResolved`.
        mkdirSync(join(dir, ".dev.vars"));

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        vi.spyOn(console, "info").mockImplementation(() => {});

        await expect(runHooks(devVariablesPlugin(RESOLVED(dir)))).resolves.toBeUndefined();
        expect(warn.mock.calls.filter(([line]) => String(line).includes("EISDIR"))).toHaveLength(1);
    });

    it("fills an empty feature-scaffolded secret + the admin token on dev (no prompt)", async () => {
        expect.assertions(3);

        // What `lunora add auth` writes into .dev.vars directly: a blank secret, no admin token.
        writeFileSync(join(dir, ".dev.vars"), "BETTER_AUTH_SECRET=\n", "utf8");

        await runHooks(devVariablesPlugin(RESOLVED(dir)));

        const content = readFileSync(join(dir, ".dev.vars"), "utf8");

        // The blank secret is now filled with a generated value (64 hex chars).
        expect(content).toMatch(/BETTER_AUTH_SECRET="[a-f0-9]{64}"/u);
        // The Studio admin token is appended + generated.
        expect(content).toMatch(/LUNORA_ADMIN_TOKEN="[a-f0-9]{64}"/u);
        expect(content).toContain("BETTER_AUTH_SECRET=");
    });

    it("marks the dev worker's environment in .dev.vars, the one channel every host reads", async () => {
        expect.assertions(2);

        // `.dev.vars` is what BOTH `@cloudflare/vite-plugin` and `wrangler dev`
        // load, so this reaches the worker whether Lunora added the Cloudflare
        // plugin or the project did (`cloudflare: false`, the vinext default).
        writeFileSync(join(dir, ".dev.vars"), "AUTH_SECRET=\n", "utf8");

        await runHooks(devVariablesPlugin(RESOLVED(dir)));

        expect(readFileSync(join(dir, ".dev.vars"), "utf8")).toMatch(/WORKER_ENV="development"/u);

        // A value the developer already declares is never overwritten.
        writeFileSync(join(dir, ".dev.vars"), `WORKER_ENV=${JSON.stringify("staging")}\n`, "utf8");

        await runHooks(devVariablesPlugin(RESOLVED(dir)));

        expect(readFileSync(join(dir, ".dev.vars"), "utf8")).toMatch(/WORKER_ENV="staging"/u);
    });

    /** A self-contained stand-in for a `defineEnv` contract requiring `keys`, carrying its brand (no `@lunora/server` import to resolve from a temp dir). */
    const writeEnvContract = (keys: string[]): void => {
        mkdirSync(join(dir, "lunora"), { recursive: true });
        writeFileSync(
            join(dir, "lunora", "env.ts"),
            `const keys = ${JSON.stringify(keys)};

const check = (env: Record<string, unknown>) =>
    keys.filter((key) => env[key] === undefined).map((key) => ({ key, message: "Expected string at <root>, received undefined" }));

export const env = Object.defineProperty((value: unknown) => value, Symbol.for("lunora.env"), { value: check });
`,
            "utf8",
        );
    };

    it("warns at startup about a key the env contract needs and the dev env lacks, then confirms an env.ts fix", async () => {
        expect.assertions(2);

        writeFileSync(join(dir, ".dev.vars"), "API_URL=https://api.test\n", "utf8");
        writeEnvContract(["API_URL", "STRIPE_KEY"]);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const plugin = devVariablesPlugin(RESOLVED(dir));

        await runHooks(plugin);

        expect(warn.mock.calls.map(([line]) => String(line)).join("\n")).toMatch(/lunora\/env\.ts: 1 key\(s\) missing[\s\S]*- STRIPE_KEY: Expected string/u);

        // An env.ts edit restarts nothing, so the plugin's own watcher re-checks it.
        let listener: ((file: string) => void) | undefined;
        const fixed = new Promise<string>((resolve) => {
            const server = {
                config: { logger: { info: resolve, warn: resolve } },
                watcher: {
                    add: (): void => {},
                    on: (event: string, handler: (file: string) => void): void => {
                        if (event === "change") {
                            listener = handler;
                        }
                    },
                },
            } as unknown as ViteDevServer;

            (plugin.configureServer as (s: ViteDevServer) => void)(server);
        });

        writeEnvContract(["API_URL"]);
        listener?.(join(dir, "lunora", "env.ts"));

        await expect(fixed).resolves.toMatch(/lunora\/env\.ts: the dev env satisfies the contract again/u);
    });

    /** Wire the plugin's watcher onto a stub server, answering the env.ts listener per event and the logger's lines. */
    const watchEnv = (plugin: Plugin): { lines: string[]; save: (event?: string) => void } => {
        const listeners = new Map<string, (file: string) => void>();
        const lines: string[] = [];
        const push = (line: string): void => {
            lines.push(line);
        };
        const server = {
            config: { logger: { info: push, warn: push } },
            watcher: {
                add: (): void => {},
                on: (event: string, handler: (file: string) => void): void => {
                    listeners.set(event, handler);
                },
            },
        } as unknown as ViteDevServer;

        (plugin.configureServer as (s: ViteDevServer) => void)(server);

        return {
            lines,
            save: (event = "change") => {
                listeners.get(event)?.(join(dir, "lunora", "env.ts"));
            },
        };
    };

    /** Resolves once the plugin has logged `count` lines — the milestone a fire-and-forget recheck reaches. */
    const logged = async (lines: string[], count: number): Promise<void> => {
        await vi.waitFor(() => {
            if (lines.length < count) {
                throw new Error(`waiting for line ${String(count)}`);
            }
        });
    };

    /** A check whose answer the test hands over when it chooses. */
    const deferredCheck = (): ((check: DevEnvCheck) => void) => {
        let answer: ((check: DevEnvCheck) => void) | undefined;

        vi.mocked(checkDevEnv).mockImplementationOnce(
            async () =>
                await new Promise<DevEnvCheck>((resolve) => {
                    answer = resolve;
                }),
        );

        return (check) => answer?.(check);
    };

    const missing: DevEnvCheck = { failures: [{ key: "STRIPE_KEY", message: "Expected string" }], kind: "invalid", sources: [".dev.vars"] };

    it("confirms a .dev.vars fix on the restart it causes, which builds a new plugin", async () => {
        expect.assertions(1);

        writeEnvContract(["STRIPE_KEY"]);
        vi.spyOn(console, "warn").mockImplementation(() => {});

        const info = vi.spyOn(console, "info").mockImplementation(() => {});

        await runHooks(devVariablesPlugin(RESOLVED(dir)));

        writeFileSync(join(dir, ".dev.vars"), "STRIPE_KEY=sk_test_1\n", "utf8");
        await runHooks(devVariablesPlugin(RESOLVED(dir)));

        expect(info.mock.calls.map(([line]) => String(line))).toContainEqual(expect.stringMatching(/the dev env satisfies the contract again/u));
    });

    it("drops a check that a later env.ts save overtook", async () => {
        expect.assertions(2);

        writeFileSync(join(dir, ".dev.vars"), "API_URL=https://api.test\n", "utf8");
        writeEnvContract(["API_URL", "STRIPE_KEY"]);
        vi.spyOn(console, "warn").mockImplementation(() => {});

        const plugin = devVariablesPlugin(RESOLVED(dir));

        await runHooks(plugin);

        const { lines, save } = watchEnv(plugin);
        const answerFirst = deferredCheck();
        const answerSecond = deferredCheck();

        save();
        save();
        answerSecond({ kind: "valid" });
        await logged(lines, 1);

        expect(lines).toStrictEqual([expect.stringContaining("satisfies the contract again")]);

        // The older check reads the contract the second save replaced: it says nothing.
        const { results } = vi.mocked(checkDevEnv).mock;

        answerFirst(missing);
        // Awaited after the plugin's own continuation was queued on it, so that one has run.
        await results.at(-2)?.value;

        expect(lines).toHaveLength(1);
    });

    it("keeps an invalid env invalid across a contract that fails to load, so the fix still says so", async () => {
        expect.assertions(2);

        writeFileSync(join(dir, ".dev.vars"), "API_URL=https://api.test\n", "utf8");
        writeEnvContract(["API_URL", "STRIPE_KEY"]);
        vi.spyOn(console, "warn").mockImplementation(() => {});

        const plugin = devVariablesPlugin(RESOLVED(dir));

        await runHooks(plugin);

        const { lines, save } = watchEnv(plugin);

        // Half-typed: the import fails.
        vi.mocked(checkDevEnv).mockResolvedValueOnce({ error: "Unexpected token", kind: "unloadable" });
        save();
        await logged(lines, 1);

        expect(lines[0]).toMatch(/could not be checked/u);

        writeEnvContract(["API_URL"]);
        save();
        await logged(lines, 2);

        expect(lines[1]).toMatch(/satisfies the contract again/u);
    });

    it("retracts its warning when the contract is deleted", async () => {
        expect.assertions(1);

        writeFileSync(join(dir, ".dev.vars"), "API_URL=https://api.test\n", "utf8");
        writeEnvContract(["API_URL", "STRIPE_KEY"]);
        vi.spyOn(console, "warn").mockImplementation(() => {});

        const plugin = devVariablesPlugin(RESOLVED(dir));

        await runHooks(plugin);

        const { lines, save } = watchEnv(plugin);

        rmSync(join(dir, "lunora", "env.ts"));
        save("unlink");
        await logged(lines, 1);

        expect(lines).toStrictEqual([expect.stringMatching(/no env contract is loaded any more/u)]);
    });

    it("checks the SvelteKit / Nuxt sidecar's config, and the bindings this session withholds", async () => {
        expect.assertions(2);

        vi.spyOn(console, "warn").mockImplementation(() => {});
        writeEnvContract(["API_URL"]);

        await runHooks(devVariablesPlugin(RESOLVED(dir), { withheld: () => ["AI"] }));

        expect(vi.mocked(checkDevEnv)).toHaveBeenLastCalledWith(expect.objectContaining({ withheld: ["AI"] }));

        writeFileSync(join(dir, "wrangler.dev.jsonc"), `{ "name": "app-dev" }`, "utf8");
        writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { "@sveltejs/kit": "^2.0.0" } }), "utf8");
        await runHooks(devVariablesPlugin(RESOLVED(dir)));

        expect(vi.mocked(checkDevEnv)).toHaveBeenLastCalledWith(
            expect.objectContaining({ configPath: join(dir, "wrangler.dev.jsonc"), vars: { WORKER_ENV: "development" } }),
        );
    });

    it("checks the Cloudflare plugin's config, not a sidecar file a non-sidecar project kept", async () => {
        expect.assertions(2);

        vi.spyOn(console, "warn").mockImplementation(() => {});
        writeEnvContract(["API_URL"]);
        writeFileSync(join(dir, "wrangler.dev.jsonc"), `{ "name": "stale-dev" }`, "utf8");

        await runHooks(devVariablesPlugin(RESOLVED(dir), { configPath: join(dir, "wrangler.custom.jsonc") }));

        const [options] = vi.mocked(checkDevEnv).mock.lastCall ?? [];

        expect(options?.configPath).toBe(join(dir, "wrangler.custom.jsonc"));
        expect(options?.vars).toBeUndefined();
    });

    it("writes nothing under `vite preview`, which resolves as a `serve` command", async () => {
        expect.assertions(1);

        writeFileSync(join(dir, ".dev.vars.example"), 'AUTH_SECRET="replace-me-openssl"\n', "utf8");

        await runHooks(devVariablesPlugin(RESOLVED(dir)), true);

        // No prompt, no minted secrets, no `.dev.vars` at all: previewing a built
        // app is not a dev session.
        expect(existsSync(join(dir, ".dev.vars"))).toBe(false);
    });

    it("is among the leading plugins so it scaffolds `.dev.vars` before the worker boots", () => {
        expect.assertions(3);

        const plugins = lunora({ cloudflare: false, overlay: false, projectRoot: dir, validateWrangler: false });
        const names = plugins.map((plugin) => plugin.name);

        // Framework detection leads (later hooks read its result); dev-vars
        // follows, still ahead of codegen and the worker plugins.
        expect(names[0]).toBe("lunora:framework-detect");
        expect(names).toContain("lunora:dev-vars");
        expect(names.indexOf("lunora:dev-vars")).toBeLessThan(names.indexOf("lunora:codegen"));
    });
});
