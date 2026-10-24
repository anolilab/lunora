import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runDeploymentsCommand } from "../../src/commands/cloudflare/deployments/handler";
import { EXIT_CODE } from "../../src/util/exit-code";
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

describe("lunora cloudflare deployments", () => {
    it("list spawns `wrangler deployments list` and forwards --format json/--env", async () => {
        expect.assertions(3);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        const result = await runDeploymentsCommand({ cwd: "/tmp", env: "production", format: "json", logger, spawner, subcommand: "list" });

        expect(result.code).toBe(0);
        expect(argsOf(calls)).toContain("wrangler deployments list");
        expect(argsOf(calls)).toContain("--json");
    });

    it("status spawns `wrangler deployments status` and forwards --format json as --json", async () => {
        expect.assertions(3);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        const result = await runDeploymentsCommand({ cwd: "/tmp", env: "production", format: "json", logger, spawner, subcommand: "status" });

        expect(result.code).toBe(0);
        expect(argsOf(calls)).toContain("wrangler deployments status --env production");
        expect(argsOf(calls)).toContain("--json");
    });

    it("status refuses the split flags, which only apply to promote", async () => {
        expect.assertions(2);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        const result = await runDeploymentsCommand({
            confirmSharedState: true,
            cwd: "/tmp",
            from: "live1",
            logger,
            percent: 10,
            spawner,
            subcommand: "status",
        });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(calls).toHaveLength(0);
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

        expect(result.code).toBe(EXIT_CODE.USAGE);
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

        expect(result.code).toBe(EXIT_CODE.USAGE);
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

    it("promote --percent N --from <live> splits traffic as `versions deploy <id>@N% <live>@(100-N)%`", async () => {
        expect.assertions(2);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        const result = await runDeploymentsCommand({
            confirmSharedState: true,
            cwd: "/tmp",
            from: "live1",
            logger,
            percent: 10,
            spawner,
            subcommand: "promote",
            versionId: "v9",
            yes: true,
        });

        expect(result.code).toBe(0);
        expect(argsOf(calls)).toContain("wrangler versions deploy v9@10% live1@90% --yes");
    });

    it("promote --percent 100 keeps the single-version argv and needs no --from", async () => {
        expect.assertions(1);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        await runDeploymentsCommand({ cwd: "/tmp", logger, percent: 100, spawner, subcommand: "promote", versionId: "v9", yes: true });

        expect(argsOf(calls)).toContain("wrangler versions deploy v9@100% --yes");
    });

    it.each([
        ["without --from", { confirmSharedState: true, percent: 10 }, "needs --from"],
        ["without --confirm-shared-state", { from: "live1", percent: 10 }, "--confirm-shared-state"],
        ["with --from equal to the promoted version", { confirmSharedState: true, from: "v9", percent: 10 }, "must name a different version"],
        ["with a fraction", { confirmSharedState: true, from: "live1", percent: 12.5 }, "whole number from 1 to 100"],
        ["with zero", { confirmSharedState: true, from: "live1", percent: 0 }, "whole number from 1 to 100"],
        ["above 100", { confirmSharedState: true, from: "live1", percent: 101 }, "whole number from 1 to 100"],
        ["with NaN", { confirmSharedState: true, from: "live1", percent: Number.NaN }, "whole number from 1 to 100"],
        ["with --from at 100%", { from: "live1", percent: 100 }, "applies only to a partial promote"],
    ])("promote refuses %s and spawns nothing", async (_label, extra, expected) => {
        expect.assertions(3);

        const { calls, spawner } = createRecordingSpawner();
        const { errors, logger } = silentLogger();

        const result = await runDeploymentsCommand({ cwd: "/tmp", logger, spawner, subcommand: "promote", versionId: "v9", yes: true, ...extra });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(errors.join("\n")).toContain(expected);
        expect(calls).toHaveLength(0);
    });

    it("rejects the split flags on subcommands other than promote", async () => {
        expect.assertions(2);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        const result = await runDeploymentsCommand({ cwd: "/tmp", from: "live1", logger, percent: 10, spawner, subcommand: "rollback", yes: true });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(calls).toHaveLength(0);
    });

    it("promote without --yes refuses to spawn", async () => {
        expect.assertions(2);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        const result = await runDeploymentsCommand({ cwd: "/tmp", logger, spawner, subcommand: "promote", versionId: "v9" });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(calls).toHaveLength(0);
    });
});
