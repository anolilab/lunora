import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});
