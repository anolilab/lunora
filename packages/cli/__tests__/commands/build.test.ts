import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runBuildCommand } from "../../src/commands/build/handler";
import type { Logger } from "../../src/util/logger";
import { createRecordingSpawner } from "../../src/util/spawn";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "..", "..", "..", "codegen", "__tests__", "fixtures", "simple");

const VALID_WRANGLER = `{
    "name": "lunora-app",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    },
    "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "real-db-id-abc123" }]
}
`;

const silentLogger = (): { logger: Logger; successes: string[] } => {
    const successes: string[] = [];

    return {
        logger: {
            error: () => {},
            info: () => {},
            success: (message) => successes.push(message),
            warn: () => {},
        },
        successes,
    };
};

let workdir: string;

describe("lunora build", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-build-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("spawns `wrangler deploy --dry-run --outdir` instead of publishing", async () => {
        expect.assertions(4);

        const { calls, spawner } = createRecordingSpawner();
        const { logger, successes } = silentLogger();

        const result = await runBuildCommand({ cwd: workdir, logger, outDir: "dist-worker", spawner });

        expect(result.code).toBe(0);

        const args = calls[0]?.descriptor.args.join(" ") ?? "";

        expect(args).toContain("--dry-run");
        expect(args).toContain("--outdir dist-worker");
        expect(successes.join("\n")).toContain("bundle written to dist-worker");
    });

    it("writes nothing extra without --emit-bindings", async () => {
        expect.assertions(1);

        const { spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        await runBuildCommand({ cwd: workdir, logger, spawner });

        expect(existsSync(join(workdir, "bindings.json"))).toBe(false);
    });

    it("--emit-bindings writes what the bundle needs provisioned", async () => {
        expect.assertions(4);

        const { spawner } = createRecordingSpawner();
        const { logger, successes } = silentLogger();

        const result = await runBuildCommand({ cwd: workdir, emitBindings: "out/bindings.json", logger, spawner });

        expect(result.code).toBe(0);

        // Relative paths resolve against the project root, and the parent
        // directory is created rather than making the caller pre-make it.
        const manifest = JSON.parse(readFileSync(join(workdir, "out", "bindings.json"), "utf8")) as {
            bindings: { binding: string; type: string }[];
            name: string;
        };

        expect(manifest.name).toBe("lunora-app");
        expect(manifest.bindings).toStrictEqual([
            { binding: "DB", resource: "x", resourceId: "real-db-id-abc123", type: "d1" },
            { binding: "SHARD", className: "ShardDO", sqlite: false, type: "durable_object" },
        ]);
        expect(successes.join("\n")).toContain("binding manifest written to");
    });

    it("--emit-bindings fails rather than describing a Worker that needs nothing", async () => {
        expect.assertions(2);

        // No wrangler config means no requirements to read. An empty manifest is
        // the dangerous answer: an IaC program would act on it by provisioning
        // nothing, and the deploy would fail at runtime on an undefined binding.
        rmSync(join(workdir, "wrangler.jsonc"), { force: true });

        const { spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        const result = await runBuildCommand({ cwd: workdir, emitBindings: "bindings.json", logger, spawner });

        expect(result.code).toBe(1);
        expect(existsSync(join(workdir, "bindings.json"))).toBe(false);
    });
});
