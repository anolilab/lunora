import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEV_LOG_FILE, readDevServerState, writeDevServerState } from "@lunora/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDevBackground, runDevLogs, runDevStatus, runDevStop } from "../../src/commands/dev/lifecycle";
import type { Logger } from "../../src/util/logger";

interface RecordingLogger {
    lines: { level: string; message: string }[];
    logger: Logger;
}

const recordingLogger = (): RecordingLogger => {
    const lines: { level: string; message: string }[] = [];
    const push = (level: string) => (message: string) => lines.push({ level, message });

    return {
        lines,
        logger: { error: push("error"), info: push("info"), success: push("success"), warn: push("warn") },
    };
};

let workdir: string;

describe("lunora dev lifecycle", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-dev-lifecycle-"));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("runDevStop", () => {
        it("is idempotent: stopping with nothing running succeeds silently", async () => {
            expect.assertions(2);

            const { lines, logger } = recordingLogger();

            const result = await runDevStop({ cwd: workdir, json: false, logger });

            expect(result.code).toBe(0);
            expect(lines.some((line) => line.message.includes("No dev server running"))).toBe(true);
        });

        it("sIGTERMs the recorded pid and clears the state record", async () => {
            expect.assertions(4);

            writeDevServerState(workdir, { mode: "cli", pid: 4242, url: "http://localhost:8787" });

            const signals: { pid: number; signal: string }[] = [];
            let dead = false;
            const { lines, logger } = recordingLogger();

            const result = await runDevStop({
                alive: () => !dead,
                cwd: workdir,
                json: false,
                logger,
                pollIntervalMs: 1,
                signal: (pid, signal) => {
                    signals.push({ pid, signal });
                    dead = true;
                },
            });

            expect(result.code).toBe(0);
            expect(signals).toStrictEqual([{ pid: 4242, signal: "SIGTERM" }]);
            expect(readDevServerState(workdir)).toBeUndefined();
            expect(lines.some((line) => line.message.includes("Stopped dev server (pid 4242)"))).toBe(true);
        });

        it("escalates a BACKGROUND record to a process-group SIGKILL when SIGTERM stalls", async () => {
            expect.assertions(2);

            // Only a background (detached) record may be group-killed — its
            // group holds nothing but our own children.
            writeDevServerState(workdir, { background: true, mode: "cli", pid: 4242, url: "http://localhost:8787" });

            const signals: { pid: number; signal: string }[] = [];

            const result = await runDevStop({
                alive: () => true,
                cwd: workdir,
                json: false,
                logger: recordingLogger().logger,
                pollIntervalMs: 1,
                signal: (pid, signal) => {
                    signals.push({ pid, signal });
                },
                stopGraceMs: 5,
            });

            expect(result.code).toBe(0);
            // SIGTERM first, then the group SIGKILL (negative pid — the pgid
            // lookup on the fake pid fails and falls back to the recorded pid).
            expect(signals).toStrictEqual([
                { pid: 4242, signal: "SIGTERM" },
                { pid: -4242, signal: "SIGKILL" },
            ]);
        });

        it("escalates a FOREGROUND record with a single-pid SIGKILL only", async () => {
            expect.assertions(1);

            // A foreground CLI may share its process group with the user's
            // shell job — group-killing it could fell innocent processes.
            writeDevServerState(workdir, { mode: "cli", pid: 4242, url: "http://localhost:8787" });

            const signals: { pid: number; signal: string }[] = [];

            await runDevStop({
                alive: () => true,
                cwd: workdir,
                json: false,
                logger: recordingLogger().logger,
                pollIntervalMs: 1,
                signal: (pid, signal) => {
                    signals.push({ pid, signal });
                },
                stopGraceMs: 5,
            });

            expect(signals).toStrictEqual([
                { pid: 4242, signal: "SIGTERM" },
                { pid: 4242, signal: "SIGKILL" },
            ]);
        });

        it("clears a stale record (dead pid) without signalling anything", async () => {
            expect.assertions(2);

            writeDevServerState(workdir, { mode: "cli", pid: 4242, url: "http://localhost:8787" });

            const signals: number[] = [];

            await runDevStop({
                alive: () => false,
                cwd: workdir,
                json: false,
                logger: recordingLogger().logger,
                signal: (pid) => {
                    signals.push(pid);
                },
            });

            expect(signals).toHaveLength(0);
            expect(readDevServerState(workdir)).toBeUndefined();
        });
    });

    describe("runDevStatus", () => {
        it("reports not-running when there is no live record", () => {
            expect.assertions(2);

            const { lines, logger } = recordingLogger();

            const result = runDevStatus({ cwd: workdir, json: false, logger });

            expect(result.code).toBe(0);
            expect(lines.some((line) => line.message.includes("No dev server running"))).toBe(true);
        });

        it("reports URL, pid, uptime, and background for a live record", () => {
            expect.assertions(3);

            // `startedAt` must postdate this process's start — a record older
            // than its own process reads as a recycled PID and is cleared.
            const startedAt = new Date().toISOString();

            writeDevServerState(workdir, { background: true, mode: "cli", pid: process.pid, startedAt, url: "http://localhost:8787" });

            const { lines, logger } = recordingLogger();

            runDevStatus({ cwd: workdir, json: false, logger });

            const banner = lines.find((line) => line.message.includes("Dev server running at http://localhost:8787"));

            expect(banner?.message).toContain(`pid ${String(process.pid)}`);
            expect(banner?.message).toContain("uptime");
            expect(banner?.message).toContain("background");
        });

        it("prints a machine-readable document with --json", () => {
            expect.assertions(2);

            writeDevServerState(workdir, { mode: "vite", pid: process.pid, url: "http://localhost:5173" });

            const chunks: string[] = [];
            const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
                chunks.push(String(chunk));

                return true;
            });

            runDevStatus({ cwd: workdir, json: true, logger: recordingLogger().logger });
            stdoutSpy.mockRestore();

            const parsed = JSON.parse(chunks.join("")) as { mode: string; running: boolean };

            expect(parsed.running).toBe(true);
            expect(parsed.mode).toBe("vite");
        });
    });

    describe("runDevLogs", () => {
        it("is forgiving when no log exists yet", () => {
            expect.assertions(2);

            const { lines, logger } = recordingLogger();

            const result = runDevLogs({ cwd: workdir, logger });

            expect(result.code).toBe(0);
            expect(lines.some((line) => line.message.includes("No dev server logs"))).toBe(true);
        });

        it("prints the trailing lines of the capture log", () => {
            expect.assertions(1);

            const logPath = join(workdir, DEV_LOG_FILE);

            mkdirSync(join(workdir, ".lunora"), { recursive: true });
            writeFileSync(logPath, "one\ntwo\nthree\n", "utf8");

            const chunks: string[] = [];
            const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
                chunks.push(String(chunk));

                return true;
            });

            runDevLogs({ cwd: workdir, lines: 2, logger: recordingLogger().logger });
            stdoutSpy.mockRestore();

            expect(chunks.join("")).toBe("two\nthree\n");
        });
    });

    describe("runDevBackground", () => {
        it("blocks until the state record + probe confirm readiness, then prints URL and pid", async () => {
            expect.assertions(4);

            const { lines, logger } = recordingLogger();

            const result = await runDevBackground({
                command: { args: ["dev"], command: "lunora" },
                cwd: workdir,
                json: false,
                logger,
                pollIntervalMs: 1,
                probe: async () => true,
                readyTimeoutMs: 2000,
                spawnDetached: () => {
                    // The "daemon" writes its state record shortly after spawn.
                    setTimeout(() => {
                        writeDevServerState(workdir, {
                            background: true,
                            mode: "cli",
                            pid: process.ppid,
                            studioUrl: "http://127.0.0.1:6173",
                            url: "http://localhost:8787",
                        });
                    }, 5);

                    return { exited: new Promise<number>(() => {}), pid: process.ppid };
                },
            });

            expect(result.code).toBe(0);

            const banner = lines.find((line) => line.message.includes("Dev server running at http://localhost:8787"));

            expect(banner?.message).toContain(`pid ${String(process.ppid)}`);
            expect(lines.some((line) => line.message.includes("lunora dev stop"))).toBe(true);
            expect(lines.some((line) => line.message.includes("lunora dev logs"))).toBe(true);
        });

        it("surfaces the log tail and fails when the daemon dies before readiness", async () => {
            expect.assertions(3);

            mkdirSync(join(workdir, ".lunora"), { recursive: true });
            writeFileSync(join(workdir, DEV_LOG_FILE), "Error: port already in use\n", "utf8");

            const { lines, logger } = recordingLogger();

            const result = await runDevBackground({
                command: { args: ["dev"], command: "lunora" },
                cwd: workdir,
                json: false,
                logger,
                pollIntervalMs: 1,
                probe: async () => false,
                readyTimeoutMs: 2000,
                spawnDetached: () => {
                    return { exited: Promise.resolve(7), pid: 999_999 };
                },
            });

            expect(result.code).toBe(7);
            expect(lines.some((line) => line.level === "error" && line.message.includes("exited before becoming ready"))).toBe(true);
            expect(lines.some((line) => line.message.includes("port already in use"))).toBe(true);
        });

        it("times out with an actionable hint when readiness is never confirmed", async () => {
            expect.assertions(2);

            const { lines, logger } = recordingLogger();

            const result = await runDevBackground({
                command: { args: ["dev"], command: "lunora" },
                cwd: workdir,
                json: false,
                logger,
                pollIntervalMs: 1,
                probe: async () => false,
                readyTimeoutMs: 25,
                spawnDetached: () => {
                    return { exited: new Promise<number>(() => {}), pid: 999_999 };
                },
            });

            expect(result.code).toBe(1);
            expect(lines.some((line) => line.level === "warn" && line.message.includes("lunora dev logs"))).toBe(true);
        });
    });
});
