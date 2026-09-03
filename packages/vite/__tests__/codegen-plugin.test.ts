import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCodegenProject, findTsconfig } from "@lunora/codegen";
import { runPostCodegenHook } from "@lunora/config";
import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { codegenPlugin } from "../src/codegen-plugin";
import type { ResolvedLunoraPluginOptions } from "../src/types";

// Spy on `createCodegenProject` (kept fully functional via `importOriginal`) so
// the tsconfig-invalidation tests below can tell a cache REBUILD apart from a
// cache REUSE without adding a test-only hook to the plugin itself. `findTsconfig`
// is spied the same way so a test can prove its (existsSync-walk) cost is paid
// only for a file actually named `tsconfig.json`, not on every watcher event.
vi.mock(import("@lunora/codegen"), async (importOriginal) => {
    const actual = await importOriginal();

    return {
        ...actual,
        createCodegenProject: vi.fn<typeof actual.createCodegenProject>(actual.createCodegenProject),
        findTsconfig: vi.fn<typeof actual.findTsconfig>(actual.findTsconfig),
    };
});

// The plugin's contract with the hook is "call it after a run that produced
// output, and arm the settle window only when it actually ran" — the hook's own
// behaviour (which script, which package manager, how failures are reported) is
// `@lunora/config`'s to test. Defaults to the real one, so every OTHER test in
// this file keeps exercising the real path: with no `package.json` in the
// fixture it correctly reports `ran: false`.
vi.mock(import("@lunora/config"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, runPostCodegenHook: vi.fn<typeof actual.runPostCodegenHook>(actual.runPostCodegenHook) };
});

const CRONS_SOURCE = `import { cronJobs } from "@lunora/scheduler";
import { internal } from "./_generated/api.js";

const crons = cronJobs();
crons.interval("clear presence", { minutes: 30 }, internal.messages.send, {});
crons.daily("send digest", { hourUTC: 9, minuteUTC: 0 }, internal.messages.send, {});
export default crons;
`;

const SCHEMA_SOURCE = `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    })
        .shardBy("channelId")
        .index("by_channel", ["channelId"]),

    users: defineTable({
        email: v.string(),
        name: v.string(),
    })
        .global()
        .index("by_email", ["email"], { unique: true }),
});
`;

const MESSAGES_SOURCE = `import { mutation, query, v } from "@lunora/server";

export const list = query({
    args: { channelId: v.id("channels"), limit: v.optional(v.number()) },
    handler: async (_context, args) => {
        return { channelId: args.channelId, limit: args.limit ?? 50 };
    },
});

export const send = mutation({
    args: { channelId: v.id("channels"), text: v.string() },
    handler: async (_context, args) => {
        return { channelId: args.channelId, text: args.text };
    },
});
`;

let workdir: string;

const writeFixture = (root: string): void => {
    mkdirSync(join(root, "lunora"), { recursive: true });
    writeFileSync(join(root, "lunora", "schema.ts"), SCHEMA_SOURCE, "utf8");
    writeFileSync(join(root, "lunora", "messages.ts"), MESSAGES_SOURCE, "utf8");
};

const makeOptions = (projectRoot: string): ResolvedLunoraPluginOptions => {
    return {
        allowUnauthenticatedShardAccess: false,
        apiSpec: "openapi",
        cloudflare: false,
        studio: false,
        generatedDir: "lunora/_generated",
        overlay: false,
        projectRoot,
        schemaDir: "lunora",
        shard: {},
        target: "cloudflare",
        validateWrangler: false,
    };
};

describe("codegen-plugin", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-vite-codegen-"));
    });

    afterEach(() => {
        // Unconditional, not trailing statements inside a test body: a failed
        // assertion would skip those, leaving `LUNORA_CODEGEN=0` set for every
        // remaining test in the file — all of which would then skip codegen and
        // fail for a reason unrelated to what actually broke.
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("codegenPlugin", () => {
        it("buildStart runs codegen and emits the three generated files", () => {
            // 9 runtime assertions; the expectTypeOf below is a compile-time check and isn't counted.
            expect.assertions(9);

            writeFixture(workdir);

            const plugin = codegenPlugin(makeOptions(workdir));
            const hook = plugin.buildStart;

            expectTypeOf(hook).not.toBeUndefined();

            // Vite's buildStart is invoked with a rollup-style context. We pass `undefined`
            // because our implementation doesn't touch it.
            (hook as (this: unknown) => void).call(undefined);

            const generatedDirectory = join(workdir, "lunora", "_generated");

            expect(existsSync(join(generatedDirectory, "api.ts"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "server.ts"))).toBe(true);
            expect(existsSync(join(generatedDirectory, "dataModel.ts"))).toBe(true);

            const api = readFileSync(join(generatedDirectory, "api.ts"), "utf8");

            expect(api).toContain("export interface ApiTypes");
            expect(api).toContain("messages:");
            expect(api).toContain('list: FunctionReference<"query"');
            expect(api).toContain('send: FunctionReference<"mutation"');

            const dataModel = readFileSync(join(generatedDirectory, "dataModel.ts"), "utf8");

            expect(dataModel).toContain("export interface Doc_messages");
            expect(dataModel).toContain("export interface Doc_users");
        });

        it("serve: LUNORA_CODEGEN=0 writes nothing and registers no codegen watcher", () => {
            expect.assertions(4);

            // The CLI spawns this dev server as a child process that re-parses its
            // own argv, so `--no-codegen` arrives as env or not at all.
            writeFixture(workdir);
            vi.stubEnv("LUNORA_CODEGEN", "0");

            const plugin = codegenPlugin(makeOptions(workdir));

            (plugin.config as (userConfig: unknown, env: { command: "build" | "serve" }) => void)(undefined, { command: "serve" });
            (plugin.buildStart as (this: unknown) => void).call(undefined);

            expect(existsSync(join(workdir, "lunora", "_generated"))).toBe(false);

            // No watcher registration: gating the RUN would still build or refresh
            // the whole ts-morph program on every save, then read the skipped result
            // as "codegen threw" and drop the cached Project — disabling codegen
            // would cost more than leaving it on.
            const handlers: string[] = [];
            const logged: string[] = [];
            const server = {
                config: {
                    logger: {
                        error: () => {},
                        info: (message: string) => {
                            logged.push(message);
                        },
                        warn: () => {},
                    },
                },
                environments: {},
                hot: { send: () => {} },
                watcher: {
                    add: () => {},
                    on: (event: string) => {
                        handlers.push(event);
                    },
                },
            };

            (plugin.configureServer as (this: unknown, s: unknown) => void).call(undefined, server);

            // The config-drift watcher (wrangler.jsonc / lunora.json → restart) is a
            // separate registration further down `configureServer` and must survive:
            // only the codegen handlers go. Enabled, "change" is registered twice.
            expect(handlers.filter((event) => event === "change")).toHaveLength(1);
            expect(logged.join(" ")).toContain("codegen watch disabled");

            // Positive control: with codegen on, the same call registers the codegen
            // handler alongside the config one — so the count above discriminates.
            vi.unstubAllEnvs();

            const enabledHandlers: string[] = [];

            (codegenPlugin(makeOptions(workdir)).configureServer as (this: unknown, s: unknown) => void).call(undefined, {
                ...server,
                watcher: {
                    add: () => {},
                    on: (event: string) => {
                        enabledHandlers.push(event);
                    },
                },
            });

            expect(enabledHandlers.filter((event) => event === "change")).toHaveLength(2);
        });

        it("build: LUNORA_CODEGEN=0 is ignored, so the ERROR-advisory gate still fails the build", async () => {
            expect.assertions(2);

            // `--no-codegen` is a DEV-WATCH switch. Honouring it in build mode would
            // skip generation AND the only thing that fails a build on an ERROR-level
            // advisory — an app shipping against a surface its target cannot serve,
            // CI green the whole way, from a variable someone exported in a shell
            // profile. Same fixture as the gate test below, with the env set.
            writeFixture(workdir);

            const badSchema = SCHEMA_SOURCE.replace(
                `.index("by_channel", ["channelId"]),`,
                `.index("by_channel", ["channelId"])\n        .index("by_bogus", ["doesNotExist"]),`,
            );

            writeFileSync(join(workdir, "lunora", "schema.ts"), badSchema, "utf8");
            vi.stubEnv("LUNORA_CODEGEN", "0");

            const plugin = codegenPlugin(makeOptions(workdir));

            (plugin.config as (userConfig: unknown, env: { command: "build" | "serve" }) => void)(undefined, { command: "build" });

            const buildContext = {
                error: (message: string): never => {
                    throw new Error(message);
                },
            };

            await expect((plugin.buildStart as (this: typeof buildContext) => Promise<void>).call(buildContext)).rejects.toThrow(
                /ERROR-level.*index_references_unknown_field/u,
            );

            expect(existsSync(join(workdir, "lunora", "_generated"))).toBe(true);
        });

        it("vite build fails when codegen reports an ERROR-level advisory (index_references_unknown_field)", async () => {
            expect.assertions(2);

            writeFixture(workdir);

            const badSchema = SCHEMA_SOURCE.replace(
                `.index("by_channel", ["channelId"]),`,
                `.index("by_channel", ["channelId"])\n        .index("by_bogus", ["doesNotExist"]),`,
            );

            expect(badSchema).not.toBe(SCHEMA_SOURCE);

            writeFileSync(join(workdir, "lunora", "schema.ts"), badSchema, "utf8");

            const plugin = codegenPlugin(makeOptions(workdir));

            // Vite calls `config` (with the resolved command) before `buildStart` on
            // every run — this is how the plugin tells a `vite build` apart from a
            // `vite dev` inside `buildStart`, which fires for both.
            (plugin.config as (userConfig: unknown, env: { command: "build" | "serve" }) => void)(undefined, { command: "build" });

            const buildContext = {
                error: (message: string): never => {
                    throw new Error(message);
                },
            };

            await expect((plugin.buildStart as (this: typeof buildContext) => Promise<void>).call(buildContext)).rejects.toThrow(
                /ERROR-level.*index_references_unknown_field/u,
            );
        });

        it("vite dev only logs the same ERROR-level advisory (never throws)", async () => {
            expect.assertions(3);

            writeFixture(workdir);

            const badSchema = SCHEMA_SOURCE.replace(
                `.index("by_channel", ["channelId"]),`,
                `.index("by_channel", ["channelId"])\n        .index("by_bogus", ["doesNotExist"]),`,
            );

            writeFileSync(join(workdir, "lunora", "schema.ts"), badSchema, "utf8");

            const errors: string[] = [];
            // eslint-disable-next-line no-console -- capturing console refs to restore after the test
            const originalError = console.error;

            // eslint-disable-next-line no-console
            console.error = (message: string) => errors.push(message);

            try {
                const plugin = codegenPlugin(makeOptions(workdir));

                (plugin.config as (userConfig: unknown, env: { command: "build" | "serve" }) => void)(undefined, { command: "serve" });

                // No `this.error`-capable context is even needed: dev never reaches it.
                await expect((plugin.buildStart as (this: unknown) => Promise<void>).call(undefined)).resolves.toBeUndefined();

                expect(errors.some((line) => line.includes("index_references_unknown_field"))).toBe(true);
                // Codegen still wrote its output — dev is log-only, not blocking.
                expect(existsSync(join(workdir, "lunora", "_generated", "api.ts"))).toBe(true);
            } finally {
                // eslint-disable-next-line no-console
                console.error = originalError;
            }
        });

        it("buildStart logs a warning when schema.ts is missing (does not crash)", () => {
            expect.assertions(2);

            const warnings: string[] = [];
            const errors: string[] = [];
            // eslint-disable-next-line no-console -- capturing console refs to restore after the test
            const originalWarn = console.warn;
            // eslint-disable-next-line no-console -- capturing console refs to restore after the test
            const originalError = console.error;

            // eslint-disable-next-line no-console
            console.warn = (message: string) => warnings.push(message);
            // eslint-disable-next-line no-console
            console.error = (message: string) => errors.push(message);

            try {
                const plugin = codegenPlugin(makeOptions(workdir));

                (plugin.buildStart as (this: unknown) => void).call(undefined);

                expect(warnings.some((warning) => warning.includes("schema.ts not found"))).toBe(true);
                expect(errors).toHaveLength(0);
            } finally {
                // eslint-disable-next-line no-console
                console.warn = originalWarn;
                // eslint-disable-next-line no-console
                console.error = originalError;
            }
        });

        it("buildStart reconciles code-first crons into wrangler.jsonc", () => {
            expect.assertions(3);

            writeFixture(workdir);
            writeFileSync(join(workdir, "lunora", "crons.ts"), CRONS_SOURCE, "utf8");
            writeFileSync(join(workdir, "wrangler.jsonc"), '{\n    // app config\n    "name": "app"\n}\n', "utf8");

            const plugin = codegenPlugin(makeOptions(workdir));

            (plugin.buildStart as (this: unknown) => void).call(undefined);

            // The generated dispatcher map lists both jobs.
            const crons = readFileSync(join(workdir, "lunora", "_generated", "crons.ts"), "utf8");

            expect(crons).toContain('name: "clear presence"');

            // wrangler.jsonc gains triggers.crons (deduped expressions), comment preserved.
            const wranglerText = readFileSync(join(workdir, "wrangler.jsonc"), "utf8");
            const wrangler = parseJsonc(wranglerText) as { triggers: { crons: string[] } };

            expect(wrangler.triggers.crons).toEqual(expect.arrayContaining(["*/30 * * * *", "0 9 * * *"]));
            expect(wranglerText).toContain("// app config");
        });

        it("plugin exposes the expected name and configureServer hook", () => {
            // 1 runtime assertion; the expectTypeOf below is a compile-time check and isn't counted.
            expect.assertions(1);

            const plugin = codegenPlugin(makeOptions(workdir));

            expect(plugin.name).toBe("lunora:codegen");

            expectTypeOf(plugin.configureServer).not.toBeUndefined();
        });
    });

    /**
     * Build a minimal stub dev server whose hot channels are Vitest spies.
     * Only the shape used by codegen-plugin needs to be present.
     *
     * `send` is the server-level channel (`server.hot.send`) the error overlay
     * uses. Each environment carries its own `hot.send` spy — `clientSend` /
     * `workerSend` — so tests can assert the scoped, per-environment reload/event
     * emitted after a successful run. Plain-object environments are treated as
     * non-runnable by `isRunnableDevEnvironment`, matching workerd + the browser.
     */
    const makeStubServer = () => {
        const send = vi.fn<(payload: unknown) => void>();
        const clientSend = vi.fn<(payload: unknown) => void>();
        const workerSend = vi.fn<(payload: unknown) => void>();
        // `restart` resolves by default; individual tests override it (e.g. to
        // reject) to exercise the config-drift auto-restart guard.
        const restart = vi.fn<() => Promise<void>>(() => Promise.resolve());

        return {
            clientSend,
            restart,
            send,
            server: {
                config: { logger: { error: vi.fn<() => void>(), info: vi.fn<() => void>(), warn: vi.fn<() => void>() } },
                // Vite 8 always exposes per-environment module graphs; codegen
                // invalidates the generated dir across all of them.
                environments: {
                    client: { hot: { send: clientSend }, moduleGraph: { idToModuleMap: new Map(), invalidateModule: vi.fn<() => void>() } },
                    worker: { hot: { send: workerSend }, moduleGraph: { idToModuleMap: new Map(), invalidateModule: vi.fn<() => void>() } },
                },
                hot: { send },
                httpServer: undefined,
                restart,
                watcher: { add: vi.fn<() => void>(), off: vi.fn<() => void>(), on: vi.fn<() => void>() },
                ws: { send: vi.fn<() => void>() },
            } as unknown as import("vite").ViteDevServer,
            workerSend,
        };
    };

    /**
     * Extract the config-drift watcher (the SECOND `change` listener the plugin
     * registers — the first is the schema-dir codegen watcher). Returns the
     * listener so a test can drive it with a config file path directly.
     */
    const getConfigChangeListener = (server: import("vite").ViteDevServer): ((file: string) => void) => {
        const changeCalls = (server.watcher.on as ReturnType<typeof vi.fn>).mock.calls.filter((args) => args[0] === "change");

        return changeCalls[1]?.[1] as (file: string) => void;
    };

    /**
     * Invoke the plugin's `configureServer` hook with the fake dev server,
     * wiring the overlay callbacks under test. Centralizes the cast so the
     * overlay cases below stay focused on their assertions.
     */
    const wireServer = (plugin: import("vite").Plugin, server: import("vite").ViteDevServer) => {
        const hook = plugin.configureServer as (server: import("vite").ViteDevServer) => void;

        hook(server);
    };

    /**
     * Drive the plugin through a real `buildStart` so the config-drift baseline is
     * "settled". The watcher only restarts on drift AFTER startup finishes — the
     * plugin's own binding-provisioning write during `buildStart` must not read as
     * external drift and restart the server mid-boot. Mirrors Vite's lifecycle:
     * `configureServer` (via {@link wireServer}) runs first, then `buildStart`.
     */
    const settleConfigBaseline = async (plugin: import("vite").Plugin): Promise<void> => {
        await (plugin.buildStart as (this: unknown) => Promise<void>).call(undefined);
    };

    describe("teardown (server close)", () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        /**
         * Invoke `configureServer` and return its "post" hook — the function Vite
         * calls after internal middlewares are installed, where teardown is
         * registered (see `wireServer` above, which discards this return value).
         */
        const configureAndCapturePost = (plugin: import("vite").Plugin, server: import("vite").ViteDevServer): (() => void) | undefined => {
            const hook = plugin.configureServer as (server: import("vite").ViteDevServer) => (() => void) | undefined;

            return hook(server);
        };

        it("middleware mode (no httpServer): buildEnd tears down watcher listeners and a later debounce performs no send", async () => {
            expect.assertions(3);

            writeFixture(workdir);

            const plugin = codegenPlugin(makeOptions(workdir));
            const { clientSend, server, workerSend } = makeStubServer();

            // `makeStubServer()`'s `httpServer: undefined` already models
            // middleware mode (`server.middlewareMode: true` forces it to `null`).
            const post = configureAndCapturePost(plugin, server);

            post?.();

            // Start a debounce — codegen hasn't run yet.
            const onChangeCalls = (server.watcher.on as ReturnType<typeof vi.fn>).mock.calls;
            const changeListener = onChangeCalls.find((args) => args[0] === "change")?.[1] as ((file: string) => void) | undefined;

            changeListener!(join(workdir, "lunora", "schema.ts"));

            // Fire the middleware-mode close signal: Vite invokes every eligible
            // plugin's `buildEnd` hook once for the "client" environment from
            // `server.close()`, regardless of middleware mode.
            (plugin.buildEnd as (this: { environment: unknown }) => void).call({ environment: server.environments.client });

            // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock on the fake server's watcher; no `this` binding to lose
            expect(server.watcher.off).toHaveBeenCalledTimes(7);

            // The pending debounce fires after close but must no-op (closed guard).
            await vi.runAllTimersAsync();

            expect(clientSend).not.toHaveBeenCalled();
            expect(workerSend).not.toHaveBeenCalled();
        });

        it("classic mode (httpServer present): teardown runs once even if the close listener fires twice", () => {
            expect.assertions(2);

            writeFixture(workdir);

            const plugin = codegenPlugin(makeOptions(workdir));
            const { server } = makeStubServer();

            const closeListeners: (() => void)[] = [];

            // A stub httpServer that records its "close" listener directly, so the
            // test can invoke it more than once — a real `EventEmitter#once` would
            // already dedupe this, but the plugin's own `closed` guard must be the
            // thing making a second fire a no-op, not the transport.
            (server as unknown as { httpServer: { once: (event: string, listener: () => void) => void } }).httpServer = {
                once: (event, listener) => {
                    if (event === "close") {
                        closeListeners.push(listener);
                    }
                },
            };

            const post = configureAndCapturePost(plugin, server);

            post?.();

            expect(closeListeners).toHaveLength(1);

            closeListeners[0]?.();
            closeListeners[0]?.();

            // eslint-disable-next-line @typescript-eslint/unbound-method -- vi.fn mock on the fake server's watcher; no `this` binding to lose
            expect(server.watcher.off).toHaveBeenCalledTimes(7);
        });
    });

    describe("overlay wiring (configureServer)", () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it("codegen throws → hot.send called once with type:error containing 'codegen failed'", async () => {
            expect.assertions(3);

            // Use a workdir WITHOUT a schema so runCodegen throws when triggered.
            // We write a bad schema file instead to force a real codegen failure.
            mkdirSync(join(workdir, "lunora"), { recursive: true });
            writeFileSync(
                join(workdir, "lunora", "schema.ts"),
                // schema missing defineSchema() call, which will cause codegen to throw
                `export const broken = true;`,
                "utf8",
            );

            const plugin = codegenPlugin(makeOptions(workdir));
            const { send, server } = makeStubServer();

            wireServer(plugin, server);

            // Trigger onChange by simulating a watcher "change" event on schema.ts.
            const onChangeCalls = (server.watcher.on as ReturnType<typeof vi.fn>).mock.calls;
            const changeListener = onChangeCalls.find((args) => args[0] === "change")?.[1] as ((file: string) => void) | undefined;

            expect(changeListener).toBeDefined();

            changeListener!(join(workdir, "lunora", "schema.ts"));

            // Advance past the debounce window.
            await vi.runAllTimersAsync();

            expect(send).toHaveBeenCalledTimes(1);

            const payload = send.mock.calls[0]?.[0] as { err: { message: string }; type: string };

            expect(payload.err.message).toContain("codegen failed");
        });

        it("non-CodegenDiagnosticError overlay message includes 'see terminal' note (no loc)", async () => {
            expect.assertions(3);

            // A plain broken schema (no defineSchema call) produces a generic Error,
            // not a CodegenDiagnosticError — so loc is undefined and the overlay
            // should include a "see terminal" note to guide the developer.
            mkdirSync(join(workdir, "lunora"), { recursive: true });
            writeFileSync(join(workdir, "lunora", "schema.ts"), `export const broken = true;`, "utf8");

            const plugin = codegenPlugin(makeOptions(workdir));
            const { send, server } = makeStubServer();

            wireServer(plugin, server);

            const onChangeCalls = (server.watcher.on as ReturnType<typeof vi.fn>).mock.calls;
            const changeListener = onChangeCalls.find((args) => args[0] === "change")?.[1] as ((file: string) => void) | undefined;

            changeListener!(join(workdir, "lunora", "schema.ts"));

            await vi.runAllTimersAsync();

            const payload = send.mock.calls[0]?.[0] as { err: { loc?: unknown; message: string }; type: string };

            // The overlay message should steer the developer to the terminal.
            expect(payload.err.message).toContain("see terminal");
            // No location in the overlay (this is a generic error, not a diagnostic).
            expect(payload.err.loc).toBeUndefined();
            expect(payload.type).toBe("error");
        });

        it("codegen diagnostic error → payload includes err.loc.file and err.loc.line", async () => {
            expect.assertions(3);

            mkdirSync(join(workdir, "lunora"), { recursive: true });

            // A schema with a non-literal `unique` value triggers a CodegenDiagnosticError.
            writeFileSync(
                join(workdir, "lunora", "schema.ts"),
                `import { defineSchema, defineTable, v } from "@lunora/server";
const flag = true;
export const schema = defineSchema({
    users: defineTable({ email: v.string() }).index("by_email", ["email"], { unique: flag }),
});`,
                "utf8",
            );

            const plugin = codegenPlugin(makeOptions(workdir));
            const { send, server } = makeStubServer();

            wireServer(plugin, server);

            const onChangeCalls = (server.watcher.on as ReturnType<typeof vi.fn>).mock.calls;
            const changeListener = onChangeCalls.find((args) => args[0] === "change")?.[1] as ((file: string) => void) | undefined;

            changeListener!(join(workdir, "lunora", "schema.ts"));

            await vi.runAllTimersAsync();

            const payload = send.mock.calls[0]?.[0] as { err: { loc?: { file: string; line: number } }; type: string };

            expect(payload.type).toBe("error");
            expect(payload.err.loc?.file).toBe(join(workdir, "lunora", "schema.ts"));
            expect(payload.err.loc?.line).toBeGreaterThan(0);
        });

        it("normal save (no prior error) → scoped worker reload + client custom event, NO blanket browser reload", async () => {
            expect.assertions(6);

            writeFixture(workdir);

            const schemaPath = join(workdir, "lunora", "schema.ts");
            const plugin = codegenPlugin(makeOptions(workdir));
            const { clientSend, send, server, workerSend } = makeStubServer();

            wireServer(plugin, server);

            const onChangeCalls = (server.watcher.on as ReturnType<typeof vi.fn>).mock.calls;
            const changeListener = onChangeCalls.find((args) => args[0] === "change")?.[1] as ((file: string) => void) | undefined;

            changeListener!(schemaPath);

            await vi.runAllTimersAsync();

            // The workerd (non-runnable) environment gets a scoped full-reload on
            // its OWN hot channel so the remote runner evicts its module cache.
            expect(workerSend).toHaveBeenCalledTimes(1);
            expect(workerSend.mock.calls[0]?.[0]).toMatchObject({ path: "*", type: "full-reload" });
            expect(workerSend.mock.calls[0]?.[0]).toHaveProperty("triggeredBy", schemaPath);

            // The client gets a non-destructive custom event — never a full-reload.
            expect(clientSend).toHaveBeenCalledTimes(1);
            expect(clientSend.mock.calls[0]?.[0]).toMatchObject({ event: "lunora:api-updated", type: "custom" });

            // The old blanket browser `full-reload` on the server-level channel is gone.
            expect(send.mock.calls.some((call) => (call[0] as { type?: string }).type === "full-reload")).toBe(false);
        });

        it("failure then success → recovery reloads the client once (clears overlay), still evicts the worker", async () => {
            expect.assertions(6);

            mkdirSync(join(workdir, "lunora"), { recursive: true });

            // Start with a broken schema.
            const schemaPath = join(workdir, "lunora", "schema.ts");

            writeFileSync(schemaPath, `export const broken = true;`, "utf8");

            const plugin = codegenPlugin(makeOptions(workdir));
            const { clientSend, send, server, workerSend } = makeStubServer();

            wireServer(plugin, server);

            const onChangeCalls = (server.watcher.on as ReturnType<typeof vi.fn>).mock.calls;
            const changeListener = onChangeCalls.find((args) => args[0] === "change")?.[1] as ((file: string) => void) | undefined;

            // First run — codegen fails, error overlay sent on the server channel.
            changeListener!(schemaPath);

            await vi.runAllTimersAsync();

            expect(send.mock.calls[0]?.[0]).toMatchObject({ type: "error" });

            // Fix the schema so codegen succeeds.
            writeFileSync(
                schemaPath,
                `import { defineSchema, defineTable, v } from "@lunora/server";
export const schema = defineSchema({ users: defineTable({ email: v.string() }) });`,
                "utf8",
            );
            writeFileSync(join(workdir, "lunora", "messages.ts"), MESSAGES_SOURCE, "utf8");

            // Second run — codegen succeeds; because an overlay was showing, the
            // client is reloaded ONCE to clear it (rather than the custom event).
            changeListener!(schemaPath);

            await vi.runAllTimersAsync();

            expect(clientSend).toHaveBeenCalledTimes(1);
            expect(clientSend.mock.calls[0]?.[0]).toMatchObject({ type: "full-reload" });

            // The client got a real reload on recovery, not the custom event.
            expect(clientSend.mock.calls.some((call) => (call[0] as { type?: string }).type === "custom")).toBe(false);

            // The workerd runner cache is still evicted on the successful run.
            expect(workerSend.mock.calls[0]?.[0]).toMatchObject({ path: "*", type: "full-reload" });

            // The server-level channel only ever sent the error overlay — no
            // blanket browser reload rode along.
            expect(send).toHaveBeenCalledTimes(1);
        });

        it("vite build fails when codegen throws (does not proceed to bundle the previous run's _generated/)", async () => {
            expect.assertions(2);

            mkdirSync(join(workdir, "lunora"), { recursive: true });
            writeFileSync(join(workdir, "lunora", "schema.ts"), `export const broken = true;`, "utf8");

            const plugin = codegenPlugin(makeOptions(workdir));

            // Do NOT call configureServer — simulates `vite build` where no dev server exists.
            (plugin.config as (userConfig: unknown, env: { command: "build" | "serve" }) => void)(undefined, { command: "build" });

            const buildContext = {
                error: (message: string): never => {
                    throw new Error(message);
                },
            };

            const errors: string[] = [];
            // eslint-disable-next-line no-console -- capturing to assert no overlay call
            const originalError = console.error;
            // eslint-disable-next-line no-console
            console.error = (message: string) => errors.push(message);

            try {
                // This test used to assert only that the build "doesn't crash and
                // logs the error". That expectation was wrong: a codegen failure is
                // the HARDEST signal the plugin has — the schema could not be parsed
                // at all — and log-only meant Rollup went on to resolve whatever
                // `_generated/*` the last good run left on disk. A schema typo in CI
                // exited 0 and shipped types and routes for a schema that no longer
                // exists, while the same hook already fails the build on the much
                // SOFTER signal three lines below (an ERROR-level advisory, i.e. a
                // call known to throw at runtime).
                await expect((plugin.buildStart as (this: typeof buildContext) => Promise<void>).call(buildContext)).rejects.toThrow(/codegen failed/u);
            } finally {
                // eslint-disable-next-line no-console
                console.error = originalError;
            }

            // Still logged on the way out, so the terminal names the real cause.
            expect(errors.some((message) => message.includes("codegen failed"))).toBe(true);
        });

        it("vite dev only logs the same codegen failure (never throws)", async () => {
            expect.assertions(2);

            mkdirSync(join(workdir, "lunora"), { recursive: true });
            writeFileSync(join(workdir, "lunora", "schema.ts"), `export const broken = true;`, "utf8");

            const plugin = codegenPlugin(makeOptions(workdir));

            (plugin.config as (userConfig: unknown, env: { command: "build" | "serve" }) => void)(undefined, { command: "serve" });

            const errors: string[] = [];
            // eslint-disable-next-line no-console -- capturing console refs to restore after the test
            const originalError = console.error;
            // eslint-disable-next-line no-console
            console.error = (message: string) => errors.push(message);

            try {
                // Dev stays log-only for the same reason it does for an ERROR-level
                // advisory: the overlay already reported it and the next save is the
                // chance to fix it.
                await expect((plugin.buildStart as (this: unknown) => Promise<void>).call(undefined)).resolves.toBeUndefined();

                expect(errors.some((message) => message.includes("codegen failed"))).toBe(true);
            } finally {
                // eslint-disable-next-line no-console
                console.error = originalError;
            }
        });

        it("missing schema.ts at buildStart warns but does not call overlay.onError (uninitialised project)", async () => {
            expect.assertions(2);

            // No `lunora/` dir at all — the normal state before `lunora init` has
            // run, or a non-Lunora project. A dev server + overlay ARE wired here
            // (unlike the "build mode" test above) specifically to prove that
            // `buildStart` never routes through them regardless — see the
            // overlay-presence guard in `runCodegenSafely`.
            const plugin = codegenPlugin(makeOptions(workdir));
            const { send, server } = makeStubServer();

            wireServer(plugin, server);

            const warnings: string[] = [];
            // eslint-disable-next-line no-console -- capturing to assert the warn fires
            const originalWarn = console.warn;

            // eslint-disable-next-line no-console
            console.warn = (message: string) => warnings.push(message);

            try {
                await (plugin.buildStart as (this: unknown) => Promise<void>).call(undefined);
            } finally {
                // eslint-disable-next-line no-console
                console.warn = originalWarn;
            }

            expect(warnings.some((message) => message.includes("schema.ts not found"))).toBe(true);
            expect(send).not.toHaveBeenCalled();
        });

        it("schema.ts deleted mid watch session → overlay.onError fires with the schema path in the message", async () => {
            expect.assertions(2);

            writeFixture(workdir);

            const schemaPath = join(workdir, "lunora", "schema.ts");
            const plugin = codegenPlugin(makeOptions(workdir));
            const { send, server } = makeStubServer();

            wireServer(plugin, server);

            // Mirrors a real session: schema.ts existed when the dev server started.
            await (plugin.buildStart as (this: unknown) => Promise<void>).call(undefined);

            send.mockClear();

            const onChangeCalls = (server.watcher.on as ReturnType<typeof vi.fn>).mock.calls;
            // The "unlink"-registered listener — matches how a real chokidar
            // deletion reaches the plugin (see the tsconfig-deletion test below).
            const unlinkListener = onChangeCalls.find((args) => args[0] === "unlink")?.[1] as ((file: string) => void) | undefined;

            rmSync(schemaPath);
            unlinkListener!(schemaPath);

            await vi.runAllTimersAsync();

            expect(send).toHaveBeenCalledTimes(1);

            const payload = send.mock.calls[0]?.[0] as { err: { message: string }; type: string };

            expect(payload.err.message).toContain(schemaPath);
        });

        it("schema.ts restored after a mid-session deletion → overlay clears and codegen resumes", async () => {
            expect.assertions(3);

            writeFixture(workdir);

            const schemaPath = join(workdir, "lunora", "schema.ts");
            const plugin = codegenPlugin(makeOptions(workdir));
            const { clientSend, send, server } = makeStubServer();

            wireServer(plugin, server);

            await (plugin.buildStart as (this: unknown) => Promise<void>).call(undefined);

            const onChangeCalls = (server.watcher.on as ReturnType<typeof vi.fn>).mock.calls;
            const changeListener = onChangeCalls.find((args) => args[0] === "change")?.[1] as ((file: string) => void) | undefined;
            const unlinkListener = onChangeCalls.find((args) => args[0] === "unlink")?.[1] as ((file: string) => void) | undefined;

            send.mockClear();
            clientSend.mockClear();

            // Delete schema.ts — overlay.onError fires.
            rmSync(schemaPath);
            unlinkListener!(schemaPath);
            await vi.runAllTimersAsync();

            expect(send).toHaveBeenCalledTimes(1);

            // Restore it — the next watcher event runs codegen successfully again,
            // and because an overlay was showing, the client is reloaded once to
            // clear it (same recovery path as any other codegen failure).
            writeFileSync(schemaPath, SCHEMA_SOURCE, "utf8");
            changeListener!(schemaPath);
            await vi.runAllTimersAsync();

            expect(clientSend).toHaveBeenCalledTimes(1);
            expect(clientSend.mock.calls[0]?.[0]).toMatchObject({ type: "full-reload" });
        });

        it("ordinary schema-dir edit with schema.ts present never calls overlay.onError", async () => {
            expect.assertions(1);

            writeFixture(workdir);

            const plugin = codegenPlugin(makeOptions(workdir));
            const { send, server } = makeStubServer();

            wireServer(plugin, server);

            const onChangeCalls = (server.watcher.on as ReturnType<typeof vi.fn>).mock.calls;
            const changeListener = onChangeCalls.find((args) => args[0] === "change")?.[1] as ((file: string) => void) | undefined;

            changeListener!(join(workdir, "lunora", "messages.ts"));
            await vi.runAllTimersAsync();

            expect(send.mock.calls.some((call) => (call[0] as { type?: string }).type === "error")).toBe(false);
        });
    });

    describe("config-drift auto-restart (configureServer)", () => {
        it("registers a config-drift watcher for wrangler + lunora.json", () => {
            expect.assertions(2);

            writeFixture(workdir);
            writeFileSync(join(workdir, "wrangler.jsonc"), '{ "name": "app" }\n', "utf8");

            const plugin = codegenPlugin(makeOptions(workdir));
            const { server } = makeStubServer();

            wireServer(plugin, server);

            // The plugin added the config files (both wrangler names + lunora.json)
            // to the watcher and registered a second `change` listener for them.
            const added = (server.watcher.add as ReturnType<typeof vi.fn>).mock.calls.flat().map(String);

            expect(added).toEqual(expect.arrayContaining([join(workdir, "wrangler.jsonc"), join(workdir, "lunora.json")]));
            expect(getConfigChangeListener(server)).toBeTypeOf("function");
        });

        it("external wrangler binding edit restarts the dev server in place", async () => {
            expect.assertions(2);

            writeFixture(workdir);
            const wranglerPath = join(workdir, "wrangler.jsonc");

            writeFileSync(wranglerPath, '{ "name": "app" }\n', "utf8");

            const plugin = codegenPlugin(makeOptions(workdir));
            const { restart, server } = makeStubServer();

            // configureServer captures the baseline; buildStart settles it after the
            // plugin's own startup binding write, so only later edits count as drift.
            wireServer(plugin, server);
            await settleConfigBaseline(plugin);

            const onConfigChange = getConfigChangeListener(server);

            // A real, binding-relevant external edit — add a D1 binding.
            writeFileSync(wranglerPath, '{ "name": "app", "d1_databases": [{ "binding": "DB", "database_name": "app" }] }\n', "utf8");
            onConfigChange(wranglerPath);

            expect(restart).toHaveBeenCalledTimes(1);

            // The guard is armed, so a second edit mid-restart does not pile on.
            onConfigChange(wranglerPath);

            expect(restart).toHaveBeenCalledTimes(1);
        });

        it("codegen's own cron-only wrangler rewrite does NOT restart (anti-loop)", async () => {
            expect.assertions(1);

            writeFixture(workdir);
            const wranglerPath = join(workdir, "wrangler.jsonc");

            // Baseline already carries every binding startup would infer (DB +
            // observability) plus a crons array — so buildStart's reconcile is a
            // no-op and the settled baseline is exactly this file (minus crons).
            writeFileSync(
                wranglerPath,
                '{ "name": "app", "d1_databases": [{ "binding": "DB" }], "observability": { "enabled": true }, "triggers": { "crons": ["0 9 * * *"] } }\n',
                "utf8",
            );

            const plugin = codegenPlugin(makeOptions(workdir));
            const { restart, server } = makeStubServer();

            wireServer(plugin, server);
            await settleConfigBaseline(plugin);

            const onConfigChange = getConfigChangeListener(server);

            // Simulate `reconcileWranglerCrons` rewriting ONLY triggers.crons.
            writeFileSync(
                wranglerPath,
                '{ "name": "app", "d1_databases": [{ "binding": "DB" }], "observability": { "enabled": true }, "triggers": { "crons": ["*/30 * * * *", "0 9 * * *"] } }\n',
                "utf8",
            );
            onConfigChange(wranglerPath);

            // crons are excluded from the fingerprint → no restart.
            expect(restart).not.toHaveBeenCalled();
        });

        it("a config write during startup adopts the baseline instead of restarting", async () => {
            expect.assertions(2);

            writeFixture(workdir);
            const wranglerPath = join(workdir, "wrangler.jsonc");

            writeFileSync(wranglerPath, '{ "name": "app" }\n', "utf8");

            const plugin = codegenPlugin(makeOptions(workdir));
            const { restart, server } = makeStubServer();

            // configureServer baselines but does NOT settle — buildStart has not run
            // yet, so its own binding-provisioning write is still pending.
            wireServer(plugin, server);

            const onConfigChange = getConfigChangeListener(server);

            // Simulate buildStart's binding write landing as a watcher event mid-boot:
            // a real, binding-relevant change arriving before the baseline settles.
            writeFileSync(wranglerPath, '{ "name": "app", "d1_databases": [{ "binding": "DB", "database_name": "app" }] }\n', "utf8");
            onConfigChange(wranglerPath);

            // Adopted as the new baseline, NOT treated as external drift → no restart.
            expect(restart).not.toHaveBeenCalled();

            // Once startup settles, a later external edit does restart as normal.
            await settleConfigBaseline(plugin);

            writeFileSync(wranglerPath, '{ "name": "app", "kv_namespaces": [{ "binding": "KV" }] }\n', "utf8");
            onConfigChange(wranglerPath);

            expect(restart).toHaveBeenCalledTimes(1);
        });

        it("lunora.json drift restarts (the cloudflare plugin does not watch it)", async () => {
            expect.assertions(2);

            writeFixture(workdir);
            // No lunora.json initially → baseline records it absent.
            const lunoraConfigPath = join(workdir, "lunora.json");

            const plugin = codegenPlugin(makeOptions(workdir));
            const { restart, server } = makeStubServer();

            wireServer(plugin, server);
            await settleConfigBaseline(plugin);

            const onConfigChange = getConfigChangeListener(server);

            // A comment/whitespace-only edit to a still-absent file is a no-op…
            onConfigChange(lunoraConfigPath);

            expect(restart).not.toHaveBeenCalled();

            // …but writing a real remote preference is binding-relevant drift.
            writeFileSync(lunoraConfigPath, '{ "remote": true }\n', "utf8");
            onConfigChange(lunoraConfigPath);

            expect(restart).toHaveBeenCalledTimes(1);
        });

        it("a rejected restart is swallowed (keeps serving) and surfaces an overlay error", async () => {
            expect.assertions(2);

            writeFixture(workdir);
            const wranglerPath = join(workdir, "wrangler.jsonc");

            writeFileSync(wranglerPath, '{ "name": "app" }\n', "utf8");

            const plugin = codegenPlugin(makeOptions(workdir));
            const { restart, send, server } = makeStubServer();

            restart.mockRejectedValueOnce(new Error("port in use"));

            wireServer(plugin, server);
            await settleConfigBaseline(plugin);

            const onConfigChange = getConfigChangeListener(server);

            writeFileSync(wranglerPath, '{ "name": "app", "kv_namespaces": [{ "binding": "KV" }] }\n', "utf8");

            // Must not throw out of the watcher even though restart rejects.
            expect(() => {
                onConfigChange(wranglerPath);
            }).not.toThrow();

            // Flush the finally/catch chain (a macrotask drains all pending microtasks).
            await new Promise((resolve) => {
                setTimeout(resolve, 0);
            });

            expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
        });
    });

    describe("tsconfig invalidation (configureServer)", () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it("a root tsconfig.json save drops the cached Project — the next codegen run builds a fresh one", async () => {
            expect.assertions(4);

            writeFixture(workdir);
            writeFileSync(join(workdir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }), "utf8");

            const plugin = codegenPlugin(makeOptions(workdir));
            const { server } = makeStubServer();

            wireServer(plugin, server);

            const onChangeCalls = (server.watcher.on as ReturnType<typeof vi.fn>).mock.calls;
            const changeListener = onChangeCalls.find((args) => args[0] === "change")?.[1] as ((file: string) => void) | undefined;
            const createCalls = createCodegenProject as ReturnType<typeof vi.fn>;
            const before = createCalls.mock.calls.length;

            // Cold start: the first schema-dir save builds the cached Project.
            changeListener!(join(workdir, "lunora", "messages.ts"));
            await vi.runAllTimersAsync();

            expect(createCalls).toHaveBeenCalledTimes(before + 1);

            // A second schema-dir save REUSES the cached Project (no rebuild).
            changeListener!(join(workdir, "lunora", "messages.ts"));
            await vi.runAllTimersAsync();

            expect(createCalls).toHaveBeenCalledTimes(before + 1);

            // Saving the ROOT tsconfig.json drops the cache. This alone triggers no
            // codegen run — there is nothing new to emit from a tsconfig save.
            changeListener!(join(workdir, "tsconfig.json"));
            await vi.runAllTimersAsync();

            expect(createCalls).toHaveBeenCalledTimes(before + 1);

            // The NEXT schema-dir save proves the drop actually happened: it
            // rebuilds a fresh Project rather than reusing the old one.
            changeListener!(join(workdir, "lunora", "messages.ts"));
            await vi.runAllTimersAsync();

            expect(createCalls).toHaveBeenCalledTimes(before + 2);
        });

        it("deleting the root tsconfig.json drops the cached Project (PR review)", async () => {
            expect.assertions(3);

            writeFixture(workdir);

            const tsconfigPath = join(workdir, "tsconfig.json");

            writeFileSync(tsconfigPath, JSON.stringify({ compilerOptions: { strict: true } }), "utf8");

            const plugin = codegenPlugin(makeOptions(workdir));
            const { server } = makeStubServer();

            wireServer(plugin, server);

            const onChangeCalls = (server.watcher.on as ReturnType<typeof vi.fn>).mock.calls;
            const changeListener = onChangeCalls.find((args) => args[0] === "change")?.[1] as ((file: string) => void) | undefined;
            // `unlink` has TWO listeners (the shared `onChange` — which can't
            // re-resolve a deleted path via `findTsconfig` — and the dedicated
            // deletion handler that actually drops the cache); chokidar would
            // invoke every listener registered for the event, so this mirrors
            // that instead of picking just one.
            const unlinkListeners = onChangeCalls.filter((args) => args[0] === "unlink").map((args) => args[1] as (file: string) => void);
            const createCalls = createCodegenProject as ReturnType<typeof vi.fn>;
            const before = createCalls.mock.calls.length;

            // Cold start: builds the cached Project.
            changeListener!(join(workdir, "lunora", "messages.ts"));
            await vi.runAllTimersAsync();

            expect(createCalls).toHaveBeenCalledTimes(before + 1);

            // Delete the tsconfig the cached Project resolved, THEN fire the
            // watcher's unlink listeners — matching real chokidar ordering,
            // where the fs change always precedes the event.
            rmSync(tsconfigPath);

            for (const listener of unlinkListeners) {
                listener(tsconfigPath);
            }

            await vi.runAllTimersAsync();

            expect(createCalls).toHaveBeenCalledTimes(before + 1);

            // The NEXT schema-dir save proves the drop happened.
            changeListener!(join(workdir, "lunora", "messages.ts"));
            await vi.runAllTimersAsync();

            expect(createCalls).toHaveBeenCalledTimes(before + 2);
        });

        it("an unrelated file save does not drop the cached Project (perf contract)", async () => {
            expect.assertions(2);

            writeFixture(workdir);

            const plugin = codegenPlugin(makeOptions(workdir));
            const { server } = makeStubServer();

            wireServer(plugin, server);

            const onChangeCalls = (server.watcher.on as ReturnType<typeof vi.fn>).mock.calls;
            const changeListener = onChangeCalls.find((args) => args[0] === "change")?.[1] as ((file: string) => void) | undefined;
            const createCalls = createCodegenProject as ReturnType<typeof vi.fn>;
            const before = createCalls.mock.calls.length;

            changeListener!(join(workdir, "lunora", "messages.ts"));
            await vi.runAllTimersAsync();

            expect(createCalls).toHaveBeenCalledTimes(before + 1);

            // Outside the schema dir entirely, and not a tsconfig — the plugin
            // ignores it outright (no codegen run), and critically must not drop
            // the cached Project either (the perf contract this plan preserves).
            changeListener!(join(workdir, "src", "unrelated.md"));
            await vi.runAllTimersAsync();

            changeListener!(join(workdir, "lunora", "messages.ts"));
            await vi.runAllTimersAsync();

            expect(createCalls).toHaveBeenCalledTimes(before + 1);
        });

        it("does not pay findTsconfig's existsSync walk on a save that isn't named tsconfig.json (perf contract)", async () => {
            expect.assertions(2);

            writeFixture(workdir);

            const plugin = codegenPlugin(makeOptions(workdir));
            const { server } = makeStubServer();

            wireServer(plugin, server);

            const onChangeCalls = (server.watcher.on as ReturnType<typeof vi.fn>).mock.calls;
            const changeListener = onChangeCalls.find((args) => args[0] === "change")?.[1] as ((file: string) => void) | undefined;
            const findTsconfigCalls = findTsconfig as ReturnType<typeof vi.fn>;

            findTsconfigCalls.mockClear();

            // A normal schema-dir save (the overwhelming majority of watcher
            // events) must never reach `findTsconfig` — only a file literally
            // named `tsconfig.json` can possibly be the one it would resolve.
            changeListener!(join(workdir, "lunora", "messages.ts"));
            await vi.runAllTimersAsync();

            expect(findTsconfigCalls).not.toHaveBeenCalled();

            // A save actually named `tsconfig.json` still resolves it, so the
            // invalidation guarantee above (the other test in this block) holds.
            changeListener!(join(workdir, "tsconfig.json"));
            await vi.runAllTimersAsync();

            expect(findTsconfigCalls).toHaveBeenCalledWith(join(workdir, "lunora"));
        });
    });

    describe("postcodegen hook (configureServer)", () => {
        beforeEach(() => {
            vi.useFakeTimers();
            vi.mocked(runPostCodegenHook).mockClear();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        /** Wire a server and hand back its `change` listener. */
        const changeListenerFor = (server: import("vite").ViteDevServer): ((file: string) => void) => {
            const { calls } = (server.watcher.on as ReturnType<typeof vi.fn>).mock;

            return calls.find((arguments_) => arguments_[0] === "change")?.[1] as (file: string) => void;
        };

        it("runs the project's postcodegen after a watch regeneration", async () => {
            expect.assertions(2);

            // Before this, a Vite or meta-framework project — the more common
            // shape — had no post-generation hook at all: `lunora dev` delegates
            // regeneration to this plugin, so the CLI's own hook never applied.
            writeFixture(workdir);

            const plugin = codegenPlugin(makeOptions(workdir));
            const { server } = makeStubServer();

            wireServer(plugin, server);
            changeListenerFor(server)(join(workdir, "lunora", "messages.ts"));
            await vi.runAllTimersAsync();

            expect(runPostCodegenHook).toHaveBeenCalledTimes(1);
            expect(vi.mocked(runPostCodegenHook).mock.calls[0]?.[0]).toMatchObject({ cwd: workdir });
        });

        it("does not arm the settle window when the project declares no hook", async () => {
            expect.assertions(1);

            // The real hook reports `ran: false` for this fixture. Arming on
            // every regeneration instead would deafen the watcher for the window
            // after each one, dropping real saves in nearly every project.
            writeFixture(workdir);

            const plugin = codegenPlugin(makeOptions(workdir));
            const { server } = makeStubServer();

            wireServer(plugin, server);

            const onChange = changeListenerFor(server);

            onChange(join(workdir, "lunora", "messages.ts"));
            await vi.runAllTimersAsync();
            onChange(join(workdir, "lunora", "messages.ts"));
            await vi.runAllTimersAsync();

            expect(runPostCodegenHook).toHaveBeenCalledTimes(2);
        });

        it("ignores a change the hook itself wrote, so regeneration cannot retrigger itself", async () => {
            expect.assertions(2);

            // `runCodegen` only writes `_generated/`, which `onChange` skips, so
            // this loop was structurally impossible before the hook. A
            // `postcodegen` is arbitrary project code, and anything it writes
            // under the schema directory looks exactly like a developer's save.
            writeFixture(workdir);
            vi.mocked(runPostCodegenHook).mockResolvedValue({ ran: true });

            const plugin = codegenPlugin(makeOptions(workdir));
            const { server } = makeStubServer();

            wireServer(plugin, server);

            const onChange = changeListenerFor(server);

            // Advance only past the debounce, NOT `runAllTimersAsync`: draining
            // every pending timer also drains the settle recheck armed at the end
            // of the run, which pushes the fake clock past HOOK_SETTLE_MS and puts
            // the second event outside the window this test is about.
            onChange(join(workdir, "lunora", "messages.ts"));
            await vi.advanceTimersByTimeAsync(150);

            expect(runPostCodegenHook).toHaveBeenCalledTimes(1);

            // Standing in for the hook's own write, inside the settle window.
            onChange(join(workdir, "lunora", "messages.ts"));
            await vi.runAllTimersAsync();

            expect(runPostCodegenHook).toHaveBeenCalledTimes(1);
        });

        it("does not push a reload when the hook failed", async () => {
            expect.assertions(2);

            // The output on disk is exactly what the hook exists to finish, so
            // pushing it serves the unfinished copy. Leaving the previous modules
            // in place keeps the app on the last version that WAS finished.
            writeFixture(workdir);
            vi.mocked(runPostCodegenHook).mockResolvedValue({ error: "`postcodegen` exited 1", ran: true });

            const plugin = codegenPlugin(makeOptions(workdir));
            const { server, workerSend } = makeStubServer();

            wireServer(plugin, server);
            changeListenerFor(server)(join(workdir, "lunora", "messages.ts"));
            await vi.runAllTimersAsync();

            expect(runPostCodegenHook).toHaveBeenCalledTimes(1);
            expect(workerSend).not.toHaveBeenCalled();
        });

        it("regenerates a developer save that landed while `postcodegen` was running", async () => {
            expect.assertions(3);

            // A real `postcodegen` (prettier/eslint/tsc over the generated output)
            // runs for seconds. Every save in that window used to be discarded
            // outright — no log, no rerun — so `_generated/` stayed behind
            // `schema.ts` until the developer happened to save again. The window
            // exists to filter the HOOK's own writes; it must not eat the
            // developer's, and the two are only distinguishable by content.
            writeFixture(workdir);
            vi.mocked(runPostCodegenHook).mockImplementation(async () => {
                await new Promise((resolve) => {
                    setTimeout(resolve, 900);
                });

                return { ran: true };
            });

            const plugin = codegenPlugin(makeOptions(workdir));
            const { server } = makeStubServer();

            wireServer(plugin, server);

            const onChange = changeListenerFor(server);
            const messagesPath = join(workdir, "lunora", "messages.ts");

            onChange(messagesPath);

            // Let the debounce fire so the hook is actually mid-run.
            await vi.advanceTimersByTimeAsync(150);

            expect(runPostCodegenHook).toHaveBeenCalledTimes(1);

            // The developer saves a new function while the hook is still running.
            writeFileSync(
                messagesPath,
                `${MESSAGES_SOURCE}
export const archive = mutation({
    args: { channelId: v.id("channels") },
    handler: async (_context, args) => {
        return { channelId: args.channelId };
    },
});
`,
                "utf8",
            );
            onChange(messagesPath);

            await vi.runAllTimersAsync();

            expect(runPostCodegenHook).toHaveBeenCalledTimes(2);
            // …and the regeneration actually consumed the new source.
            expect(readFileSync(join(workdir, "lunora", "_generated", "api.ts"), "utf8")).toContain("archive");
        });

        it("does not rerun when the hook only rewrote its own output", async () => {
            expect.assertions(2);

            // The other half of the same discrimination: a hook that touches
            // nothing under the schema directory (or rewrites a file to identical
            // bytes) leaves the sources' fingerprint unchanged, so the settle
            // recheck must stay silent rather than trade the old spin loop for a
            // new one.
            writeFixture(workdir);
            vi.mocked(runPostCodegenHook).mockImplementation(async () => {
                await new Promise((resolve) => {
                    setTimeout(resolve, 900);
                });

                return { ran: true };
            });

            const plugin = codegenPlugin(makeOptions(workdir));
            const { server } = makeStubServer();

            wireServer(plugin, server);

            const onChange = changeListenerFor(server);

            onChange(join(workdir, "lunora", "messages.ts"));
            await vi.advanceTimersByTimeAsync(150);

            expect(runPostCodegenHook).toHaveBeenCalledTimes(1);

            // Standing in for the hook's own write — same bytes on disk.
            onChange(join(workdir, "lunora", "messages.ts"));
            await vi.runAllTimersAsync();

            expect(runPostCodegenHook).toHaveBeenCalledTimes(1);
        });

        it("stops rerunning, and says why, once a non-idempotent hook has spun the recheck twice", async () => {
            expect.assertions(2);

            // The recheck converges for any idempotent `postcodegen` — a formatter
            // reaches a fixed point on its second pass. A hook that writes DIFFERENT
            // bytes under the schema directory every run never does, and would hand
            // the dev loop back exactly the spin the settle window exists to
            // prevent. MAX_SETTLE_RERUNS caps it: the initial run plus two reruns.
            writeFixture(workdir);

            let hookRuns = 0;

            vi.mocked(runPostCodegenHook).mockImplementation(async () => {
                hookRuns += 1;

                // Stands in for a hook stamping a timestamp/generated id into a
                // schema-directory file: never the same bytes twice.
                writeFileSync(join(workdir, "lunora", "stamp.ts"), `export const stamp = ${String(hookRuns)};\n`, "utf8");

                return { ran: true };
            });

            const plugin = codegenPlugin(makeOptions(workdir));
            const { server } = makeStubServer();

            wireServer(plugin, server);
            changeListenerFor(server)(join(workdir, "lunora", "messages.ts"));
            await vi.runAllTimersAsync();

            expect(runPostCodegenHook).toHaveBeenCalledTimes(3);

            const warnings = (server.config.logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));

            expect(warnings.join("\n")).toContain("keeps rewriting the schema sources");
        });

        it("resumes regenerating once the settle window has passed", async () => {
            expect.assertions(1);

            // The window must not swallow real edits beyond it — otherwise the
            // guard above would trade a spin loop for a dead watcher.
            writeFixture(workdir);
            vi.mocked(runPostCodegenHook).mockResolvedValue({ ran: true });

            const plugin = codegenPlugin(makeOptions(workdir));
            const { server } = makeStubServer();

            wireServer(plugin, server);

            const onChange = changeListenerFor(server);

            onChange(join(workdir, "lunora", "messages.ts"));
            await vi.runAllTimersAsync();

            await vi.advanceTimersByTimeAsync(400);
            onChange(join(workdir, "lunora", "messages.ts"));
            await vi.runAllTimersAsync();

            expect(runPostCodegenHook).toHaveBeenCalledTimes(2);
        });
    });
});
