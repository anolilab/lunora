import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runDeploymentsCommand } from "../../src/commands/deployments/handler";
import type { Logger } from "../../src/util/logger";
import { createRecordingSpawner } from "../../src/util/spawn";

const silentLogger = (): { errors: string[]; logger: Logger } => {
    const errors: string[] = [];

    return {
        errors,
        logger: {
            error: (message) => errors.push(message),
            info: () => {},
            success: () => {},
            warn: () => {},
        },
    };
};

const argsOf = (calls: ReturnType<typeof createRecordingSpawner>["calls"]): string => calls[0]?.descriptor.args.join(" ") ?? "";

/** A cwd whose nearest package.json declares npm, so `detectPackageManager` resolves npm. */
const npmProjectCwd = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "lunora-cli-deployments-npm-"));
    writeFileSync(join(dir, "package.json"), `{ "packageManager": "npm@10.9.0" }\n`, "utf8");

    return dir;
};

describe("lunora deployments", () => {
    it("list spawns `wrangler deployments list` and forwards --json/--env", async () => {
        expect.assertions(3);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        const result = await runDeploymentsCommand({ cwd: "/tmp", env: "production", json: true, logger, spawner, subcommand: "list" });

        expect(result.code).toBe(0);
        expect(argsOf(calls)).toContain("wrangler deployments list");
        expect(argsOf(calls)).toContain("--json");
    });

    it("launches wrangler through npx when the project declares npm", async () => {
        expect.assertions(2);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        await runDeploymentsCommand({ cwd: npmProjectCwd(), logger, spawner, subcommand: "list" });

        expect(calls[0]?.descriptor.command).toBe("npx");
        expect(calls[0]?.descriptor.args).toStrictEqual(["--", "wrangler", "deployments", "list"]);
    });

    it("inspect requires a version id", async () => {
        expect.assertions(2);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        const result = await runDeploymentsCommand({ cwd: "/tmp", logger, spawner, subcommand: "inspect" });

        expect(result.code).toBe(1);
        expect(calls).toHaveLength(0);
    });

    it("inspect <id> spawns `wrangler versions view <id>`", async () => {
        expect.assertions(1);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        await runDeploymentsCommand({ cwd: "/tmp", logger, spawner, subcommand: "inspect", versionId: "abc-123" });

        expect(argsOf(calls)).toContain("wrangler versions view abc-123");
    });

    it("rollback without --yes refuses to spawn", async () => {
        expect.assertions(2);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        const result = await runDeploymentsCommand({ cwd: "/tmp", logger, spawner, subcommand: "rollback" });

        expect(result.code).toBe(1);
        expect(calls).toHaveLength(0);
    });

    it("rollback --yes spawns `wrangler rollback --yes` (version id optional)", async () => {
        expect.assertions(2);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        await runDeploymentsCommand({ cwd: "/tmp", logger, message: "revert", spawner, subcommand: "rollback", versionId: "v9", yes: true });

        const args = argsOf(calls);

        expect(args).toContain("wrangler rollback v9 --yes");
        expect(args).toContain("--message revert");
    });

    it("promote <id> --yes splits 100% traffic via `versions deploy <id>@100%`", async () => {
        expect.assertions(1);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        await runDeploymentsCommand({ cwd: "/tmp", logger, spawner, subcommand: "promote", versionId: "v9", yes: true });

        expect(argsOf(calls)).toContain("wrangler versions deploy v9@100% --yes");
    });

    it("promote without --yes refuses to spawn", async () => {
        expect.assertions(2);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        const result = await runDeploymentsCommand({ cwd: "/tmp", logger, spawner, subcommand: "promote", versionId: "v9" });

        expect(result.code).toBe(1);
        expect(calls).toHaveLength(0);
    });
});
