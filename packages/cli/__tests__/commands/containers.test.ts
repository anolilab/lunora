import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { execute, runContainersCommand } from "../../src/commands/containers/handler";
import type { ContainersOptions } from "../../src/commands/containers/index";
import { EXIT_CODE } from "../../src/util/exit-code";
import type { Logger } from "../../src/util/logger";
import { createRecordingSpawner } from "../../src/util/spawn";
import { runExecute } from "../helpers/execute";

// `execute` spawns through the module-level `defaultSpawner` — there is no
// injection seam on the cerebro path — so the forwarded run is stubbed here.
vi.mock(import("../../src/util/spawn"), async (importOriginal) => {
    return {
        ...(await importOriginal()),
        defaultSpawner: async () => {
            return { code: 0 };
        },
    };
});

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

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(calls).toHaveLength(0);
        expect(errors.join(" ")).toContain("requires a subcommand");
    });

    it("blocks build when no Docker engine is available", async () => {
        expect.assertions(3);

        const { calls, spawner } = createRecordingSpawner();
        const { errors, logger } = silentLogger();

        const result = await runContainersCommand({ argument: ["build", "."], dockerAvailable: () => false, logger, spawner, tag: "x:y" });

        // The bucket that exists for exactly this: a local tool the command
        // shells out to is not there, so automation provisions rather than retries.
        expect(result.code).toBe(EXIT_CODE.MISSING_DEPENDENCY);
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

    /**
     * Through `execute`, because the envelope is `defineHandler`'s: every other
     * test here calls `runContainersCommand`, which writes nothing, so a marker
     * this handler failed to forward was invisible to all of them.
     */
    describe("--format json envelope", () => {
        it("stays silent on a forwarded read — wrangler already wrote the document", async () => {
            expect.assertions(2);

            const { stdout } = await runExecute<ContainersOptions>(execute, {
                argument: ["images", "list"],
                commandName: "containers",
                cwd: npmProjectCwd(),
                options: { format: "json" },
            });

            // `delegated` suppresses the envelope. Dropping it appended a second
            // JSON document after wrangler's own, and the concatenation parses
            // as neither.
            expect(stdout).toBe("");
            expect(() => JSON.parse(stdout === "" ? "{}" : stdout)).not.toThrow();
        });

        it("carries the refusal reason for a subcommand that cannot answer as JSON", async () => {
            expect.assertions(3);

            const { code, document } = await runExecute<ContainersOptions>(execute, {
                argument: ["build", "."],
                commandName: "containers",
                cwd: npmProjectCwd(),
                options: { format: "json" },
            });

            expect(code).toBe(EXIT_CODE.USAGE);
            expect(document?.code).toBe(EXIT_CODE.USAGE);
            expect(document?.error).toContain("--format json is only available");
        });
    });
});
