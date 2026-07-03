import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Logger } from "../../src/util/logger";
import { buildRailpackImages } from "../../src/util/railpack";
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
    const dir = mkdtempSync(join(tmpdir(), "lunora-cli-railpack-npm-"));
    writeFileSync(join(dir, "package.json"), `{ "packageManager": "npm@10.9.0" }\n`, "utf8");

    return dir;
};

describe(buildRailpackImages, () => {
    it("is a no-op with no targets", async () => {
        expect.assertions(2);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        const result = await buildRailpackImages({ cwd: "/p", logger, spawner, targets: [] });

        expect(result.code).toBe(0);
        expect(calls).toHaveLength(0);
    });

    it("builds then pushes each target under its deterministic tag", async () => {
        expect.assertions(4);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        const result = await buildRailpackImages({
            cwd: "/p",
            logger,
            railpackAvailable: () => true,
            spawner,
            targets: [
                { buildDir: "./services/transcoder", exportName: "transcoder" },
                { buildDir: "./services/resizer", exportName: "imageResizer" },
            ],
        });

        expect(result.builtTags).toStrictEqual(["lunora-transcoder:build", "lunora-image-resizer:build"]);
        expect(calls).toHaveLength(4);
        expect(calls[0]?.descriptor).toMatchObject({ args: ["build", "./services/transcoder", "--name", "lunora-transcoder:build"], command: "railpack" });
        expect(calls[1]?.descriptor).toMatchObject({ args: ["exec", "wrangler", "containers", "push", "lunora-transcoder:build"], command: "pnpm" });
    });

    it("pushes through npx when the project declares npm (build stays on the railpack binary)", async () => {
        expect.assertions(3);

        const { calls, spawner } = createRecordingSpawner();
        const { logger } = silentLogger();

        const result = await buildRailpackImages({
            cwd: npmProjectCwd(),
            logger,
            railpackAvailable: () => true,
            spawner,
            targets: [{ buildDir: "./services/transcoder", exportName: "transcoder" }],
        });

        expect(result.code).toBe(0);
        // The Railpack build is its own binary — only the wrangler push routes through the manager.
        expect(calls[0]?.descriptor).toMatchObject({ args: ["build", "./services/transcoder", "--name", "lunora-transcoder:build"], command: "railpack" });
        expect(calls[1]?.descriptor).toMatchObject({ args: ["--", "wrangler", "containers", "push", "lunora-transcoder:build"], command: "npx" });
    });

    it("blocks when Railpack/BuildKit is unavailable, without spawning", async () => {
        expect.assertions(3);

        const { calls, spawner } = createRecordingSpawner();
        const { errors, logger } = silentLogger();

        const result = await buildRailpackImages({
            cwd: "/p",
            logger,
            railpackAvailable: () => false,
            spawner,
            targets: [{ buildDir: "./s", exportName: "worker" }],
        });

        expect(result.code).toBe(1);
        expect(calls).toHaveLength(0);
        expect(errors.join(" ")).toContain("BuildKit");
    });

    it("stops at the first failed build and reports it", async () => {
        expect.assertions(2);

        const { spawner } = createRecordingSpawner(1); // every spawn fails
        const { logger } = silentLogger();

        const result = await buildRailpackImages({
            cwd: "/p",
            logger,
            railpackAvailable: () => true,
            spawner,
            targets: [{ buildDir: "./s", exportName: "worker" }],
        });

        expect(result.code).toBe(1);
        expect(result.error).toContain('railpack build failed for container "worker"');
    });
});
