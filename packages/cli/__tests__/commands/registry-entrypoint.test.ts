/**
 * Entrypoint re-export injection for registry items — class-B/C workers get the
 * `export * from "./lunora/<module>.js"` line appended idempotently; class-A
 * projects get a fallback instruction instead.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAddCommand } from "../../src/commands/registry/index";
import type { Logger } from "../../src/util/logger";

const silentLogger = (): Logger => {
    const noop = (): void => {};

    return { error: noop, info: noop, success: noop, warn: noop };
};

const capturingLogger = (): { lines: string[]; logger: Logger } => {
    const lines: string[] = [];
    const push = (message: string): void => {
        lines.push(message);
    };

    return { lines, logger: { error: push, info: push, success: push, warn: push } };
};

let registryRoot: string;
let workdir: string;

const seedItem = (): void => {
    mkdirSync(join(registryRoot, "workflow"), { recursive: true });
    writeFileSync(
        join(registryRoot, "workflow", "registry.json"),
        JSON.stringify(
            {
                entrypointReexports: [{ comment: "Workflow entrypoints", module: "_generated/workflows" }],
                files: [{ from: "workflow.ts", merge: "create-or-skip", to: "lunora/workflow/index.ts" }],
                name: "workflow",
            },
            undefined,
            2,
        ),
        "utf8",
    );
    writeFileSync(join(registryRoot, "workflow", "workflow.ts"), "export const foo = 1;\n", "utf8");
};

const workerEntry = (): string => join(workdir, "src", "server", "index.ts");

const addWorkflow = async (logger: Logger = silentLogger()): Promise<void> => {
    const result = await runAddCommand({ cwd: workdir, from: registryRoot, logger, names: ["workflow"], yes: true });

    if (result.code !== 0) {
        throw new Error(`runAddCommand failed with code ${String(result.code)}`);
    }
};

describe("lunora add — entrypoint re-export injection", () => {
    beforeEach(() => {
        registryRoot = mkdtempSync(join(tmpdir(), "lunora-reg-"));
        seedItem();

        workdir = mkdtempSync(join(tmpdir(), "lunora-proj-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        mkdirSync(join(workdir, "src", "server"), { recursive: true });
        writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies: {}, name: "demo" }, undefined, 4), "utf8");
        writeFileSync(join(workdir, "wrangler.jsonc"), '{\n    "main": "src/server/index.ts"\n}\n', "utf8");
        writeFileSync(workerEntry(), 'import { createShardDO } from "./lunora/_generated/shard.js";\nexport const ShardDO = createShardDO({});\n', "utf8");
    });

    afterEach(() => {
        rmSync(registryRoot, { force: true, recursive: true });
        rmSync(workdir, { force: true, recursive: true });
    });

    it("injects the re-export line into the worker entry", async () => {
        expect.assertions(2);

        await addWorkflow();

        const source = readFileSync(workerEntry(), "utf8");

        expect(source).toContain('export * from "../../lunora/_generated/workflows.js";');
        expect(source).toContain("// Workflow entrypoints");
    });

    it("is idempotent — a second add does not duplicate the re-export", async () => {
        expect.assertions(1);

        await addWorkflow();
        await addWorkflow();

        const source = readFileSync(workerEntry(), "utf8");

        expect(source.split('export * from "../../lunora/_generated/workflows.js";').length - 1).toBe(1);
    });

    it("does not mistake a longer path for an existing re-export", async () => {
        expect.assertions(1);

        // An existing export for a *different* module whose path is a prefix of
        // the target module must not block injection of the target.
        writeFileSync(
            workerEntry(),
            'import { createShardDO } from "./lunora/_generated/shard.js";\nexport const ShardDO = createShardDO({});\nexport * from "../../lunora/_generated/workflows-extra.js";\n',
            "utf8",
        );

        await addWorkflow();

        const source = readFileSync(workerEntry(), "utf8");

        expect(source).toContain('export * from "../../lunora/_generated/workflows.js";');
    });

    it("logs a fallback instruction for class-A projects", async () => {
        expect.assertions(2);

        // No createShardDO call → class-A; the item cannot safely rewrite entry.
        writeFileSync(workerEntry(), 'export default { fetch: () => new Response("ok") };\n', "utf8");

        const { lines, logger } = capturingLogger();

        await addWorkflow(logger);

        const warning = lines.find((line) => line.includes("Add `export * from"));

        expect(warning).toBeDefined();
        expect(warning).toContain('"./lunora/_generated/workflows.js"');
    });

    it("falls back to conventional entry paths when wrangler main is missing", async () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "wrangler.jsonc"), "{}\n", "utf8");

        await addWorkflow();

        expect(readFileSync(workerEntry(), "utf8")).toContain('export * from "../../lunora/_generated/workflows.js";');
    });

    it("probes past a marker-less fallback candidate instead of stopping there", async () => {
        expect.assertions(1);

        // No wrangler `main` declared — falls back to WORKER_ENTRY_FALLBACKS.
        // `src/server.ts` exists first in the fallback order but is NOT the
        // class-B/C worker entry (no `createShardDO(` marker); `src/index.ts`,
        // probed later in the fallback order, is. The old candidate-loop
        // `break` stopped at the first EXISTING candidate regardless of
        // whether it had the marker, so it never reached `src/index.ts`.
        writeFileSync(join(workdir, "wrangler.jsonc"), "{}\n", "utf8");
        rmSync(workerEntry(), { force: true });
        writeFileSync(join(workdir, "src", "server.ts"), 'export default { fetch: () => new Response("ok") };\n', "utf8");
        writeFileSync(
            join(workdir, "src", "index.ts"),
            'import { createShardDO } from "./lunora/_generated/shard.js";\nexport const ShardDO = createShardDO({});\n',
            "utf8",
        );

        await addWorkflow();

        const source = readFileSync(join(workdir, "src", "index.ts"), "utf8");

        expect(source).toContain('export * from "../lunora/_generated/workflows.js";');
    });

    it("ignores a commented-out wrangler main (JSONC-aware, not a naive regex match against raw text)", async () => {
        expect.assertions(1);

        // A regex scan of the raw file text (blind to comments) would
        // incorrectly treat this out-of-date, commented-out `main` as
        // pointing at `src/worker.ts` — an existing file with no
        // `createShardDO(` marker — and (with the old unconditional
        // break-on-first-existing-candidate bug) give up right there without
        // ever reaching the real entry (`src/server/index.ts`).
        writeFileSync(join(workdir, "wrangler.jsonc"), '{\n    // "main": "src/worker.ts"\n}\n', "utf8");
        writeFileSync(join(workdir, "src", "worker.ts"), 'export default { fetch: () => new Response("ok") };\n', "utf8");

        await addWorkflow();

        const source = readFileSync(workerEntry(), "utf8");

        expect(source).toContain('export * from "../../lunora/_generated/workflows.js";');
    });
});
