import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDeployCommand } from "../../src/commands/deploy/handler";
import { EXIT_CODE } from "../../src/util/exit-code";
import type { Logger } from "../../src/util/logger";
import { createRecordingSpawner } from "../../src/util/spawn";

// The scan lists each source folder with readdirSync. This mock makes one folder fail with EACCES, the error a
// folder without read permission raises, so the case runs the same on every runner (Windows and root included).
// The loosened signature + module cast are required: `readdirSync`'s overloads share no single assignable shape.
vi.mock(import("node:fs"), async (importOriginal) => {
    const actual = await importOriginal();
    const listing = actual.readdirSync as (...parameters: unknown[]) => unknown;

    return {
        ...actual,
        readdirSync: (path: unknown, ...rest: unknown[]): unknown => {
            if (String(path).replaceAll("\\", "/").endsWith("/src/locked")) {
                throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
            }

            return listing(path, ...rest);
        },
    } as unknown as typeof actual;
});

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

describe("open-shard-access gate on a folder it cannot read", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-open-shards-unreadable-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
        mkdirSync(join(workdir, "src", "locked"), { recursive: true });
        writeFileSync(join(workdir, "src", "locked", "app.ts"), `export const options = () => ({\n    allowUnauthenticatedShardAccess: true,\n});\n`, "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("refuses the deploy and names the folder it could not read", async () => {
        expect.assertions(2);

        const errors: string[] = [];
        const logger: Logger = { error: (message) => errors.push(message), info: () => {}, success: () => {}, warn: () => {} };
        const result = await runDeployCommand({ cwd: workdir, logger, spawner: createRecordingSpawner().spawner });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(errors.some((line) => line.includes("src/locked"))).toBe(true);
    });
});
