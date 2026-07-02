import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import codegenPlugin from "../src/codegen-plugin";
import type { ResolvedLunoraPluginOptions } from "../src/types";

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
        validateWrangler: false,
    };
};

describe("codegen-plugin", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-vite-codegen-"));
    });

    afterEach(() => {
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
     * Build a minimal stub dev server whose `hot.send` is a Vitest spy.
     * Only the shape used by codegen-plugin needs to be present.
     */
    const makeStubServer = () => {
        const send = vi.fn<(payload: unknown) => void>();

        return {
            send,
            server: {
                config: { logger: { error: vi.fn<() => void>(), info: vi.fn<() => void>(), warn: vi.fn<() => void>() } },
                // Vite 8 always exposes per-environment module graphs; codegen
                // invalidates the generated dir across all of them.
                environments: {
                    client: { moduleGraph: { idToModuleMap: new Map(), invalidateModule: vi.fn<() => void>() } },
                    worker: { moduleGraph: { idToModuleMap: new Map(), invalidateModule: vi.fn<() => void>() } },
                },
                hot: { send },
                httpServer: undefined,
                watcher: { add: vi.fn<() => void>(), off: vi.fn<() => void>(), on: vi.fn<() => void>() },
                ws: { send: vi.fn<() => void>() },
            } as unknown as import("vite").ViteDevServer,
        };
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

        it("failure then success → second run sends exactly one type:full-reload (no double reload)", async () => {
            expect.assertions(4);

            mkdirSync(join(workdir, "lunora"), { recursive: true });

            // Start with a broken schema.
            const schemaPath = join(workdir, "lunora", "schema.ts");

            writeFileSync(schemaPath, `export const broken = true;`, "utf8");

            const plugin = codegenPlugin(makeOptions(workdir));
            const { send, server } = makeStubServer();

            wireServer(plugin, server);

            const onChangeCalls = (server.watcher.on as ReturnType<typeof vi.fn>).mock.calls;
            const changeListener = onChangeCalls.find((args) => args[0] === "change")?.[1] as ((file: string) => void) | undefined;

            // First run — codegen fails, error overlay sent.
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

            // Second run — codegen succeeds, overlay should be cleared via full-reload.
            changeListener!(schemaPath);

            await vi.runAllTimersAsync();

            expect(send.mock.calls[1]?.[0]).toMatchObject({ type: "full-reload" });

            // Exactly one `full-reload` for the recovery — the success path and
            // the change path must not both fire for the same triggering change.
            const fullReloads = send.mock.calls.filter((call) => (call[0] as { type?: string }).type === "full-reload");

            expect(fullReloads).toHaveLength(1);
            // Total sends: one error (first run) + one full-reload (recovery).
            expect(send).toHaveBeenCalledTimes(2);
        });

        it("build mode (no dev server) → no hot.send, returns undefined on failure", async () => {
            expect.assertions(1);

            mkdirSync(join(workdir, "lunora"), { recursive: true });
            writeFileSync(join(workdir, "lunora", "schema.ts"), `export const broken = true;`, "utf8");

            const plugin = codegenPlugin(makeOptions(workdir));

            // Do NOT call configureServer — simulates `vite build` where no dev server exists.
            const errors: string[] = [];
            // eslint-disable-next-line no-console -- capturing to assert no overlay call
            const originalError = console.error;
            // eslint-disable-next-line no-console
            console.error = (message: string) => errors.push(message);

            try {
                await (plugin.buildStart as (this: unknown) => Promise<void>).call(undefined);
            } finally {
                // eslint-disable-next-line no-console
                console.error = originalError;
            }

            // We just need to confirm the build doesn't crash and logs the error.
            expect(errors.some((message) => message.includes("codegen failed"))).toBe(true);
        });
    });
});
