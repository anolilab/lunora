import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runContainersCommand } from "../../src/commands/containers/handler";
import type { Logger } from "../../src/util/logger";
import { createRecordingSpawner } from "../../src/util/spawn";

const silentLogger = (): { errors: string[]; logger: Logger } => {
    const errors: string[] = [];

    return {
        errors,
        logger: { error: (message) => errors.push(message), info: () => {}, success: () => {}, warn: () => {} },
    };
};

/** A cwd whose nearest package.json declares npm, so `detectPackageManager` resolves npm. */
const npmProjectCwd = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "lunora-cli-containers-npm-"));
    writeFileSync(join(dir, "package.json"), `{ "packageManager": "npm@10.9.0" }\n`, "utf8");

    return dir;
};

describe("lunora containers", () => {
    it("forwards build with positional args and curated options to wrangler", async () => {
        expect.assertions(2);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        const result = await runContainersCommand({
            argument: ["build", "./containers/transcoder"],
            cwd: "/home/user/project",
            dockerAvailable: () => true,
            logger,
            push: true,
            spawner,
            tag: "transcoder:v1",
        });

        expect(result.code).toBe(0);
        expect(calls[0]?.descriptor.args).toEqual(["exec", "wrangler", "containers", "build", "./containers/transcoder", "--tag", "transcoder:v1", "--push"]);
    });

    it("forwards images subcommand verbatim", async () => {
        expect.assertions(1);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        await runContainersCommand({ argument: ["images", "list"], dockerAvailable: () => true, logger, spawner });

        expect(calls[0]?.descriptor.args).toEqual(["exec", "wrangler", "containers", "images", "list"]);
    });

    it("launches wrangler through npx when the project declares npm", async () => {
        expect.assertions(1);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        await runContainersCommand({ argument: ["images", "list"], cwd: npmProjectCwd(), dockerAvailable: () => true, logger, spawner });

        expect(calls[0]?.descriptor).toMatchObject({ args: ["--", "wrangler", "containers", "images", "list"], command: "npx" });
    });

    it("rejects an unknown subcommand without spawning", async () => {
        expect.assertions(3);

        const { calls, spawner } = createRecordingSpawner();
        const { errors, logger } = silentLogger();

        const result = await runContainersCommand({ argument: ["frobnicate"], logger, spawner });

        expect(result.code).toBe(1);
        expect(calls).toHaveLength(0);
        expect(errors.join(" ")).toContain("requires a subcommand");
    });

    it("blocks build when no Docker engine is available", async () => {
        expect.assertions(3);

        const { calls, spawner } = createRecordingSpawner();
        const { errors, logger } = silentLogger();

        const result = await runContainersCommand({ argument: ["build", "."], dockerAvailable: () => false, logger, spawner, tag: "x:y" });

        expect(result.code).toBe(1);
        expect(calls).toHaveLength(0);
        expect(errors.join(" ")).toContain("Docker-compatible engine");
    });

    it("does not require Docker for registry-side subcommands", async () => {
        expect.assertions(1);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        await runContainersCommand({ argument: ["images", "list"], dockerAvailable: () => false, logger, spawner });

        expect(calls).toHaveLength(1);
    });
});
