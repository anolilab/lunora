import { describe, expect, it } from "vitest";

import { runLogsCommand } from "../../src/commands/logs.js";
import type { Logger } from "../../src/util/logger.js";
import { createRecordingSpawner } from "../../src/util/spawn.js";

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

describe("cirrus logs", () => {
    it("spawns `pnpm exec wrangler tail`", async () => {
        expect.assertions(3);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        const result = await runLogsCommand({ cwd: "/tmp", logger, spawner });

        expect(result.code).toBe(0);
        expect(calls).toHaveLength(1);

        const args = calls[0]?.descriptor.args.join(" ") ?? "";

        expect(args).toContain("wrangler tail");
    });

    it("forwards worker name, --env, --format, --status, and --search", async () => {
        expect.assertions(6);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        await runLogsCommand({
            cwd: "/tmp",
            env: "production",
            format: "json",
            logger,
            search: "boom",
            spawner,
            status: "error",
            worker: "my-worker",
        });

        const args = calls[0]?.descriptor.args ?? [];

        // The Worker name is positional and must precede the flags.
        expect(args.indexOf("my-worker")).toBeLessThan(args.indexOf("--env"));
        expect(args).toContain("production");
        expect(args).toContain("--format");
        expect(args).toContain("json");
        expect(args).toContain("--status");
        expect(args).toContain("boom");
    });

    it("rejects an unknown --format without spawning", async () => {
        expect.assertions(3);

        const { calls, spawner } = createRecordingSpawner();
        const { errors, logger } = silentLogger();

        const result = await runLogsCommand({ cwd: "/tmp", format: "yaml", logger, spawner });

        expect(result.code).toBe(1);
        expect(calls).toHaveLength(0);
        expect(errors.some((line) => line.includes("--format"))).toBe(true);
    });
});
