import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runDeployCommand } from "../../src/commands/deploy/handler";
import type { Logger } from "../../src/util/logger";
import { createRecordingSpawner } from "../../src/util/spawn";

const fixtureLunora = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "codegen", "__tests__", "fixtures", "simple", "lunora");

const WRANGLER = `{
    "name": "shop",
    "main": "src/index.ts",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["nodejs_compat"],
    "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShardDO"] }],
    "durable_objects": { "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }] },
    "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "real-db-id-abc123" }]
}
`;

const logger: Logger = { error: () => undefined, info: () => undefined, success: () => undefined, warn: () => undefined };
const noRemoteSecrets = (): Promise<{ names: string[]; ok: boolean }> => Promise.resolve({ names: [], ok: false });

describe("lunora deploy with the studio companion", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-deploy-companion-"));
        cpSync(fixtureLunora, join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "wrangler.jsonc"), WRANGLER, "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    const deploy = async (companion: boolean) => {
        writeFileSync(join(workdir, "lunora.config.ts"), `export default { studio: { companion: ${String(companion)} } };\n`, "utf8");

        const { calls, spawner } = createRecordingSpawner();
        const result = await runDeployCommand({ cwd: workdir, dryRun: true, logger, secretLister: noRemoteSecrets, spawner });

        return { calls, result };
    };

    it("deploys the companion Worker before the app, and only runs wrangler in its folder", async () => {
        expect.assertions(3);

        const { calls, result } = await deploy(true);
        const companionDirectory = join(workdir, "lunora", "_generated", "companion");
        const inCompanion = calls.filter((call) => call.descriptor.cwd === companionDirectory);

        expect(result.code).toBe(0);
        expect(calls[0]?.descriptor.args.join(" ")).toContain(`wrangler deploy --config ${join(companionDirectory, "wrangler.jsonc")}`);
        // No client build (vite etc.) belongs to a folder that holds only a Worker.
        expect(inCompanion.map((call) => call.descriptor.args.join(" "))).toStrictEqual([expect.stringContaining("wrangler deploy")]);
    });

    it("deploys no companion while the flag is off", async () => {
        expect.assertions(1);

        const { calls } = await deploy(false);

        expect(calls.some((call) => call.descriptor.args.join(" ").includes("companion"))).toBe(false);
    });
});
