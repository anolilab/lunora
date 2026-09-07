import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BuildCommandResult } from "../../src/commands/build/handler";
import { runBuildCommand } from "../../src/commands/build/handler";
import type { Logger } from "../../src/util/logger";
import type { Spawner } from "../../src/util/spawn";
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
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "real-db-id-abc123" }]
}
`;

const silentLogger = (): { logger: Logger; successes: string[]; warnings: string[] } => {
    const successes: string[] = [];
    const warnings: string[] = [];

    return {
        logger: {
            error: () => {},
            info: () => {},
            success: (message) => successes.push(message),
            warn: (message) => warnings.push(message),
        },
        successes,
        warnings,
    };
};

/** Worker script the fake wrangler "bundles" — big enough that gzip is a real number. */
const SCRIPT = `export default { fetch() { return new Response(${JSON.stringify("ok".repeat(4096))}); } };\n`;

let workdir: string;

/**
 * A spawner that writes what `wrangler deploy --outdir` writes: the script, its
 * sourcemap, the esbuild metafile, and wrangler's explanatory README — so the
 * measurement is exercised against the layout it actually has to filter.
 */
const bundlingSpawner =
    (outDirectory: string): Spawner =>
    async (descriptor) => {
        const directory = join(workdir, outDirectory);

        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "server.js"), SCRIPT, "utf8");
        writeFileSync(join(directory, "server.js.map"), "x".repeat(50_000), "utf8");
        writeFileSync(join(directory, "bundle-meta.json"), "y".repeat(50_000), "utf8");
        writeFileSync(join(directory, "README.md"), "wrangler wrote this\n", "utf8");

        return { code: 0, descriptor, stderr: "", stdout: "" };
    };

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
            { binding: "SHARD", className: "ShardDO", sqlite: true, type: "durable_object" },
        ]);
        expect(successes.join("\n")).toContain("binding manifest written to");
    });

    it("--emit-bindings describes the crons provisioning added, and still leaves wrangler.jsonc untouched", async () => {
        expect.assertions(3);

        // The committed config declares no `triggers`; the app declares a nightly
        // cron. Provisioning reconciles it into wrangler.jsonc — and the dry-run
        // rollback used to put the original bytes back BEFORE the manifest was
        // derived, so the document handed to Terraform/Pulumi said `"crons": []`
        // for an app with a nightly job that would then never be provisioned.
        writeFileSync(
            join(workdir, "lunora", "crons.ts"),
            `import { cronJobs } from "@lunora/server";\n\nconst crons = cronJobs();\n\ncrons.daily("nightly-billing-sweep", { hourUTC: 3, minuteUTC: 0 }, internal.messages.purge, {});\n\nexport default crons;\n`,
            "utf8",
        );

        const { spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        const result = await runBuildCommand({ cwd: workdir, emitBindings: "bindings.json", logger, spawner });

        expect(result.code).toBe(0);

        const manifest = JSON.parse(readFileSync(join(workdir, "bindings.json"), "utf8")) as { crons: string[] };

        expect(manifest.crons).toStrictEqual(["0 3 * * *"]);
        // The build published nothing, so the committed config is byte-identical.
        expect(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")).toBe(VALID_WRANGLER);
    });

    it("weighs the bundle it wrote, counting only what Cloudflare uploads", async () => {
        expect.assertions(4);

        const { logger } = silentLogger();

        const result = await runBuildCommand({ cwd: workdir, logger, outDir: "dist-worker", spawner: bundlingSpawner("dist-worker") });

        // The sourcemap, the metafile and wrangler's README are all in the
        // out-dir and none of them ship — counting them would report a bundle
        // roughly three times its real weight.
        expect(result.bundle?.files).toBe(1);
        expect(result.bundle?.rawBytes).toBe(Buffer.byteLength(SCRIPT));
        expect(result.bundle?.gzipBytes).toBe(gzipSync(Buffer.from(SCRIPT)).byteLength);
        expect(result.bundle?.gzipBytes).toBeGreaterThan(0);
    });

    it("reports the size in the --format json document without failing on it", async () => {
        expect.assertions(3);

        const { logger } = silentLogger();
        const written: string[] = [];
        const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
            written.push(String(chunk));

            return true;
        });

        let result: BuildCommandResult;

        try {
            result = await runBuildCommand({
                cwd: workdir,
                format: "json",
                logger,
                outDir: "dist-worker",
                spawner: bundlingSpawner("dist-worker"),
            });
        } finally {
            spy.mockRestore();
        }

        // Measuring is reporting: a size never changes the exit code.
        expect(result.code).toBe(0);

        const document = JSON.parse(written.join("")) as BuildCommandResult;

        expect(written).toHaveLength(1);
        expect(document.bundle?.gzipBytes).toBeGreaterThan(0);
    });

    it("says so rather than reporting zero when there is nothing to weigh", async () => {
        expect.assertions(2);

        const { logger, warnings } = silentLogger();

        // The recording spawner writes no out-dir — which is what a changed
        // wrangler layout would also look like. A 0-byte bundle would read as
        // the healthiest possible result, so it must not be reported at all.
        const { spawner } = createRecordingSpawner();
        const result = await runBuildCommand({ cwd: workdir, logger, spawner });

        expect(result.bundle).toBeUndefined();
        expect(warnings.join("\n")).toContain("could not weigh the bundle");
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
