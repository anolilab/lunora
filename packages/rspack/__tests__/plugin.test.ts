import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CompilationLike, CompilerLike } from "../src/compiler";
import { lunoraRspack, resolveOptions, resolveRunnableTargetOrThrow, VERSION } from "../src/index";

let workdir: string;

const SCHEMA = `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    }).shardBy("channelId"),
});
`;

/** The same schema plus a `.global()` table, which implies the D1 binding Lunora provisions itself. */
const SCHEMA_WITH_GLOBAL = `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    }).shardBy("channelId"),

    users: defineTable({
        email: v.string(),
    }).global(),
});
`;

const VALID_WRANGLER = `{
    "name": "lunora-app",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["web_socket_auto_reply_to_close"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }]
}
`;

/**
 * A compiler stand-in that records the taps instead of running a build, plus
 * `run()` / `afterCompile()` to drive them. Structural, like `CompilerLike`
 * itself — `compiler-projection.test.ts` is what pins the shape against the real
 * `@rspack/core`, so this one can stay a plain object.
 */
const fakeCompiler = (
    watchMode: boolean,
): {
    afterCompile: (compilation: CompilationLike) => Promise<void>;
    compiler: CompilerLike;
    run: () => Promise<void>;
} => {
    const taps: { afterCompile?: (compilation: CompilationLike) => Promise<void>; beforeCompile?: (value: unknown) => Promise<void> } = {};

    return {
        afterCompile: async (compilation) => taps.afterCompile?.(compilation),
        compiler: {
            hooks: {
                afterCompile: {
                    tapPromise: (_name, callback) => {
                        taps.afterCompile = callback;
                    },
                },
                beforeCompile: {
                    tapPromise: (_name, callback) => {
                        taps.beforeCompile = callback;
                    },
                },
            },
            watchMode,
        },
        run: async () => taps.beforeCompile?.(undefined),
    };
};

/** A compilation stand-in that records what the plugin asks to be watched. */
const fakeCompilation = (): { compilation: CompilationLike; contexts: string[] } => {
    const contexts: string[] = [];

    return {
        compilation: { contextDependencies: { add: (dependency) => contexts.push(dependency) }, errors: [], warnings: [] },
        contexts,
    };
};

describe(lunoraRspack, () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-rspack-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "lunora", "schema.ts"), SCHEMA, "utf8");
        writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
        writeFileSync(join(workdir, "package.json"), '{ "name": "app" }\n', "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
        vi.restoreAllMocks();
    });

    it("generates into <schemaDir>/_generated on the first compilation", async () => {
        expect.assertions(2);

        vi.spyOn(console, "info").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});

        const harness = fakeCompiler(false);

        lunoraRspack({ projectRoot: workdir }).apply(harness.compiler);

        await harness.run();

        expect(existsSync(join(workdir, "lunora", "_generated"))).toBe(true);
        expect(existsSync(join(workdir, "lunora", "_generated", "api.ts"))).toBe(true);
    });

    it("watches the schema directory so a newly added function file rebuilds", async () => {
        expect.assertions(1);

        vi.spyOn(console, "info").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});

        const harness = fakeCompiler(true);
        const { compilation, contexts } = fakeCompilation();

        lunoraRspack({ projectRoot: workdir, validateWrangler: false }).apply(harness.compiler);

        await harness.afterCompile(compilation);

        // The DIRECTORY, not a file list: a brand-new `lunora/foo.ts` is
        // discovered by codegen without being imported from anywhere, so a
        // file-list watch would never see it appear.
        expect(contexts).toStrictEqual([join(workdir, "lunora")]);
    });

    it("provisions the D1 binding a .global() table implies before validating", async () => {
        expect.assertions(1);

        vi.spyOn(console, "info").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        writeFileSync(join(workdir, "lunora", "schema.ts"), SCHEMA_WITH_GLOBAL, "utf8");
        // `.global()` emits a D1-backed `ctx.db`, and codegen refuses to emit an
        // import the project has not declared.
        writeFileSync(join(workdir, "package.json"), '{ "name": "app", "dependencies": { "@lunora/d1": "*" } }\n', "utf8");

        const harness = fakeCompiler(false);

        lunoraRspack({ projectRoot: workdir }).apply(harness.compiler);

        // Validation demands the `DB` binding; provisioning writes it. Reversing
        // the two fails the first build of any project with a `.global()` table,
        // so this passing IS the ordering assertion.
        await expect(harness.run()).resolves.toBeUndefined();
    });

    it("fails a production build when wrangler.jsonc is missing", async () => {
        expect.assertions(1);

        vi.spyOn(console, "info").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        rmSync(join(workdir, "wrangler.jsonc"));

        const harness = fakeCompiler(false);

        lunoraRspack({ projectRoot: workdir }).apply(harness.compiler);

        await expect(harness.run()).rejects.toThrow("wrangler.jsonc not found");
    });

    it("skips the wrangler check under validateWrangler: false", async () => {
        expect.assertions(1);

        vi.spyOn(console, "info").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        rmSync(join(workdir, "wrangler.jsonc"));

        const harness = fakeCompiler(false);

        lunoraRspack({ projectRoot: workdir, validateWrangler: false }).apply(harness.compiler);

        await expect(harness.run()).resolves.toBeUndefined();
    });

    it("warns instead of throwing when there is no schema yet", async () => {
        expect.assertions(1);

        vi.spyOn(console, "info").mockImplementation(() => {});

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        rmSync(join(workdir, "lunora", "schema.ts"));

        const harness = fakeCompiler(false);

        lunoraRspack({ projectRoot: workdir, validateWrangler: false }).apply(harness.compiler);

        await harness.run();

        // An uninitialised project is the normal state before `lunora init`;
        // failing the build there would make the plugin unusable in a template.
        expect(warn.mock.calls.flat().join("\n")).toContain("no schema found");
    });

    it("taps nothing when codegen is disabled by env", async () => {
        expect.assertions(2);

        const info = vi.spyOn(console, "info").mockImplementation(() => {});

        vi.stubEnv("LUNORA_CODEGEN", "false");

        const harness = fakeCompiler(false);

        lunoraRspack({ projectRoot: workdir }).apply(harness.compiler);

        await harness.run();

        expect(existsSync(join(workdir, "lunora", "_generated"))).toBe(false);
        expect(info.mock.calls.flat().join("\n")).toContain("codegen disabled");

        vi.unstubAllEnvs();
    });

    it("reports the package's real version", () => {
        expect.assertions(1);

        const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

        expect(VERSION).toBe(manifest.version);
    });
});

describe(resolveOptions, () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-rspack-options-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("defaults to the cloudflare target, the lunora schema dir, and openapi", () => {
        expect.assertions(1);

        expect(resolveOptions({ projectRoot: workdir })).toStrictEqual({
            apiSpec: "openapi",
            projectRoot: workdir,
            schemaDir: "lunora",
            target: "cloudflare",
            validateWrangler: true,
        });
    });

    it("rejects a target with no command-line toolchain", () => {
        expect.assertions(1);

        // `node` is a legitimate CODEGEN target, so `resolveTargetOrThrow` alone
        // accepts it — and the build would then emit the wrong surface silently.
        expect(() => resolveRunnableTargetOrThrow(workdir, "node")).toThrow("has no command-line toolchain");
    });

    it("rejects an unknown target", () => {
        expect.assertions(1);

        expect(() => resolveOptions({ projectRoot: workdir, target: "not-a-target" })).toThrow("not-a-target");
    });
});
