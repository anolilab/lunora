import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { runEnvCommand } from "../../src/commands/env.js";
import type { Logger } from "../../src/util/logger.js";
import { createRecordingSpawner } from "../../src/util/spawn.js";

interface Recorded {
    errors: string[];
    infos: string[];
    successes: string[];
    warnings: string[];
}

const recordingLogger = (): { logger: Logger; recorded: Recorded } => {
    const recorded: Recorded = { errors: [], infos: [], successes: [], warnings: [] };

    return {
        logger: {
            error: (message) => recorded.errors.push(message),
            info: (message) => recorded.infos.push(message),
            success: (message) => recorded.successes.push(message),
            warn: (message) => recorded.warnings.push(message),
        },
        recorded,
    };
};

let workdir: string;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "cirrus-cli-env-"));
});

afterEach(() => {
    rmSync(workdir, { force: true, recursive: true });
});

describe("cirrus env", () => {
    test("list on a missing .dev.vars reports empty without erroring", async () => {
        const { logger, recorded } = recordingLogger();

        const result = await runEnvCommand({ cwd: workdir, logger, subcommand: "list" });

        expect(result.code).toBe(0);
        expect(recorded.infos.join("\n")).toContain("(empty)");
    });

    test("set then list redacts values and persists across calls", async () => {
        const { logger, recorded } = recordingLogger();

        await runEnvCommand({ cwd: workdir, key: "API_KEY", logger, subcommand: "set", value: "supersecret-value" });
        await runEnvCommand({ cwd: workdir, key: "DB_URL", logger, subcommand: "set", value: "postgres://x" });

        const file = readFileSync(join(workdir, ".dev.vars"), "utf8");

        expect(file).toContain("API_KEY=");
        expect(file).toContain("DB_URL=");

        await runEnvCommand({ cwd: workdir, logger, subcommand: "list" });

        const listed = recorded.infos.join("\n");

        expect(listed).toMatch(/API_KEY=supe\*+/u);
        // Full value never appears in list output.
        expect(listed).not.toContain("supersecret-value");
    });

    test("get prints the full value to stdout", async () => {
        const { logger } = recordingLogger();

        await runEnvCommand({ cwd: workdir, key: "TOKEN", logger, subcommand: "set", value: "abcd1234" });

        const written: string[] = [];
        const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
            written.push(typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));

            return true;
        }) as typeof process.stdout.write);

        try {
            const result = await runEnvCommand({ cwd: workdir, key: "TOKEN", logger, subcommand: "get" });

            expect(result.code).toBe(0);
            expect(written.join("")).toContain("abcd1234");
        } finally {
            spy.mockRestore();
        }
    });

    test("get on a missing key returns 1", async () => {
        const { logger, recorded } = recordingLogger();

        writeFileSync(join(workdir, ".dev.vars"), "EXISTING=ok\n", "utf8");

        const result = await runEnvCommand({ cwd: workdir, key: "MISSING", logger, subcommand: "get" });

        expect(result.code).toBe(1);
        expect(recorded.errors.join("\n")).toContain("MISSING");
    });

    test("unset removes a key and is idempotent", async () => {
        const { logger, recorded } = recordingLogger();

        await runEnvCommand({ cwd: workdir, key: "A", logger, subcommand: "set", value: "1" });
        await runEnvCommand({ cwd: workdir, key: "B", logger, subcommand: "set", value: "2" });

        await runEnvCommand({ cwd: workdir, key: "A", logger, subcommand: "unset" });

        const file = readFileSync(join(workdir, ".dev.vars"), "utf8");

        expect(file).not.toMatch(/^A=/mu);
        expect(file).toMatch(/^B=/mu);

        const second = await runEnvCommand({ cwd: workdir, key: "A", logger, subcommand: "unset" });

        expect(second.code).toBe(0);
        expect(recorded.warnings.join("\n")).toContain("A");
    });

    test("push without --yes is refused", async () => {
        const { logger, recorded } = recordingLogger();

        writeFileSync(join(workdir, ".dev.vars"), "SECRET=value\n", "utf8");

        const { calls, spawner } = createRecordingSpawner();

        const result = await runEnvCommand({ cwd: workdir, logger, spawner, subcommand: "push" });

        expect(result.code).toBe(1);
        expect(calls).toHaveLength(0);
        expect(recorded.errors.join("\n")).toContain("--yes");
    });

    test("push with --yes invokes wrangler secret put per key (sequentially, value via env)", async () => {
        const { logger } = recordingLogger();

        writeFileSync(join(workdir, ".dev.vars"), "FIRST=one\nSECOND=two\n", "utf8");

        const { calls, spawner } = createRecordingSpawner();

        const result = await runEnvCommand({ cwd: workdir, logger, spawner, subcommand: "push", yes: true });

        expect(result.code).toBe(0);
        expect(calls).toHaveLength(2);
        // The value is piped into stdin, never in argv or env.
        expect(calls[0]?.descriptor.args.join(" ")).toBe("exec wrangler secret put FIRST");
        expect(calls[1]?.descriptor.args.join(" ")).toBe("exec wrangler secret put SECOND");
        expect(calls[0]?.descriptor.input).toBe("one");
        expect(calls[1]?.descriptor.input).toBe("two");
        // Sanity: no env leak.
        expect(calls[0]?.descriptor.env).toBeUndefined();
    });

    test("push --prod adds --env production", async () => {
        const { logger } = recordingLogger();

        writeFileSync(join(workdir, ".dev.vars"), "OK=1\n", "utf8");

        const { calls, spawner } = createRecordingSpawner();

        await runEnvCommand({ cwd: workdir, logger, prod: true, spawner, subcommand: "push", yes: true });

        expect(calls[0]?.descriptor.args).toContain("--env");
        expect(calls[0]?.descriptor.args).toContain("production");
    });

    test("push aborts immediately on first wrangler failure", async () => {
        const { logger } = recordingLogger();

        writeFileSync(join(workdir, ".dev.vars"), "A=1\nB=2\nC=3\n", "utf8");

        const { calls, spawner } = createRecordingSpawner(2);

        const result = await runEnvCommand({ cwd: workdir, logger, spawner, subcommand: "push", yes: true });

        expect(result.code).toBe(2);
        // Sequential: must have stopped after the first failure.
        expect(calls).toHaveLength(1);
    });

    test("set rejects invalid keys (cannot start with digit)", async () => {
        const { logger, recorded } = recordingLogger();

        const result = await runEnvCommand({ cwd: workdir, key: "1BAD", logger, subcommand: "set", value: "x" });

        expect(result.code).toBe(1);
        expect(existsSync(join(workdir, ".dev.vars"))).toBe(false);
        expect(recorded.errors.join("\n")).toContain("invalid key");
    });
});
