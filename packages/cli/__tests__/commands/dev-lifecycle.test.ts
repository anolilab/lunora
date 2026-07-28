import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claimDevServerState, DEV_LOG_FILE, readDevServerState, writeDevServerState } from "@lunora/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DevOptions } from "../../src/commands/dev/index";
import { runDevBackground, runDevLogs, runDevStatus, runDevStop, startBackground } from "../../src/commands/dev/lifecycle";
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
                // Alive until the SIGKILL lands — the post-force-kill check must
                // observe the death or stop now reports failure.
                alive: () => !signals.some((sent) => sent.signal === "SIGKILL"),
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
                alive: () => !signals.some((sent) => sent.signal === "SIGKILL"),
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

        it("leaves a record another server claimed after the stale read", async () => {
            expect.assertions(1);

            writeDevServerState(workdir, { mode: "cli", pid: 4242, url: "http://localhost:8787" });

            await runDevStop({
                // The observed record is dead — but by clear time a NEW server
                // has re-claimed the file. The pid-guarded clear must not
                // delete that fresh record.
                alive: () => {
                    writeDevServerState(workdir, { mode: "cli", pid: 5353, url: "http://localhost:8788" });

                    return false;
                },
                cwd: workdir,
                json: false,
                logger: recordingLogger().logger,
                signal: () => {},
            });

            expect(readDevServerState(workdir)?.pid).toBe(5353);
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

    describe("startBackground", () => {
        it("claims a provisional record, hands its pid to the child, and clears after", async () => {
            expect.assertions(4);

            let envSeen: Record<string, string | undefined> | undefined;
            let pidDuringRun: number | undefined;

            const result = await startBackground({
                cwd: workdir,
                jsonLogs: false,
                logger: recordingLogger().logger,
                options: {} as DevOptions,
                remote: false,
                run: (options) => {
                    envSeen = options.env;
                    // The provisional record is already claimed when the child spawns.
                    pidDuringRun = readDevServerState(workdir)?.pid;

                    return Promise.resolve({ code: 0 });
                },
            });

            expect(result.code).toBe(0);
            expect(pidDuringRun).toBe(process.pid);
            expect(envSeen?.LUNORA_DEV_HANDOFF_PID).toBe(String(process.pid));
            // No child superseded it, so the provisional record is gone.
            expect(readDevServerState(workdir)).toBeUndefined();
        });

        it("forwards --target to the daemon", async () => {
            expect.assertions(2);

            let args: ReadonlyArray<string> | undefined;

            await startBackground({
                cwd: workdir,
                jsonLogs: false,
                logger: recordingLogger().logger,
                options: { target: "aws" } as DevOptions,
                remote: false,
                run: (options) => {
                    args = options.command.args;

                    return Promise.resolve({ code: 0 });
                },
            });

            // The daemon is a fresh process that re-parses argv, so a flag not
            // forwarded here is silently dropped — and `--background` is the
            // automatic path when an AI agent runs `lunora dev`, which made this
            // the default way to lose the flag.
            expect(args).toContain("--target");
            expect(args?.[(args.indexOf("--target") ?? 0) + 1]).toBe("aws");
        });

        it("omits --target when none was given", async () => {
            expect.assertions(1);

            let args: ReadonlyArray<string> | undefined;

            await startBackground({
                cwd: workdir,
                jsonLogs: false,
                logger: recordingLogger().logger,
                options: {} as DevOptions,
                remote: false,
                run: (options) => {
                    args = options.command.args;

                    return Promise.resolve({ code: 0 });
                },
            });

            // Absent, not empty-string: the daemon re-reads `lunora.json`, so
            // passing `--target ""` would override a project setting with junk.
            expect(args).not.toContain("--target");
        });

        it("loses the claim to a live incumbent and reports it without spawning", async () => {
            expect.assertions(4);

            // A live record owned by a different process (the runner's parent).
            writeDevServerState(workdir, { mode: "cli", pid: process.ppid, url: "http://localhost:8787" });

            let spawned = false;
            const { lines, logger } = recordingLogger();

            const result = await startBackground({
                cwd: workdir,
                jsonLogs: false,
                logger,
                options: {} as DevOptions,
                remote: false,
                run: () => {
                    spawned = true;

                    return Promise.resolve({ code: 0 });
                },
            });

            expect(result.code).toBe(0);
            expect(spawned).toBe(false);
            expect(lines.some((line) => line.message.includes("already running"))).toBe(true);
            // The incumbent's record is untouched.
            expect(readDevServerState(workdir)?.pid).toBe(process.ppid);
        });
    });

    describe("runDevBackground", () => {
        it("spawns a real detached child through the default spawner (integration)", async () => {
            expect.assertions(4);

            const posix = process.platform !== "win32";

            // No spawnDetached stub — the REAL default spawner runs. The child
            // plays the daemon: logs a line, writes its own state record (as the
            // wrangler daemon / vite plugin would), and stays alive past the wait.
            const script = [
                "const fs = require('node:fs');",
                "console.log('child-alive');",
                "fs.mkdirSync('.lunora', { recursive: true });",
                "fs.writeFileSync('.lunora/dev.json', JSON.stringify({ mode: 'cli', pid: process.pid, startedAt: new Date().toISOString(), url: 'http://localhost:1' }));",
                "setTimeout(() => {}, 30_000);",
            ].join(" ");

            const result = await runDevBackground({
                command: { args: ["-e", script], command: process.execPath },
                cwd: workdir,
                json: false,
                logger: recordingLogger().logger,
                pollIntervalMs: 25,
                probe: async () => true,
                readyTimeoutMs: 15_000,
            });

            const state = readDevServerState(workdir);

            try {
                expect(result.code).toBe(0);
                expect(state?.pid).toBeGreaterThan(0);

                // The capture log received the child's stdout — created 0600 on
                // POSIX (dev output can echo secrets).
                const logPath = join(workdir, DEV_LOG_FILE);

                expect(readFileSync(logPath, "utf8")).toContain("child-alive");

                // eslint-disable-next-line no-bitwise -- extract the permission bits from st_mode
                const mode = statSync(logPath).mode & 0o777;

                // Windows has no POSIX permission bits — assert 0600 only there.
                expect(posix ? mode : 0o600).toBe(0o600);
            } finally {
                if (state !== undefined) {
                    try {
                        process.kill(state.pid, "SIGKILL");
                    } catch {
                        /* already gone */
                    }
                }
            }
        }, 20_000);

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
            expect.assertions(3);

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
            // The child's pid is surfaced in the warning so an agent (or human)
            // knows which process to inspect without a separate `dev status`.
            expect(lines.some((line) => line.level === "warn" && line.message.includes("(pid 999999)"))).toBe(true);
        });

        it("hands the provisional record to the detached child when the ready wait times out", async () => {
            expect.assertions(3);

            // Simulate the parent's own provisional claim, as `startBackground`
            // does before spawning the detached child.
            claimDevServerState(workdir, {
                background: true,
                mode: "cli",
                pid: process.pid,
                startedAt: new Date().toISOString(),
                url: "http://localhost:8787",
            });

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
                    return { exited: new Promise<number>(() => {}), pid: 4242 };
                },
            });

            expect(result.code).toBe(1);
            // The record now points at the detached child, not the parent that
            // is about to return — `dev status`/`stop`/`logs` can still find
            // and signal it instead of reporting "No dev server running".
            expect(readDevServerState(workdir)?.pid).toBe(4242);
            expect(lines.some((line) => line.level === "warn" && line.message.includes("(pid 4242)"))).toBe(true);
        });

        it("does not clobber the child's own authoritative record when it supersedes before the timeout fires", async () => {
            expect.assertions(3);

            claimDevServerState(workdir, {
                background: true,
                mode: "cli",
                pid: process.pid,
                startedAt: new Date().toISOString(),
                url: "http://localhost:8787",
            });

            const result = await runDevBackground({
                command: { args: ["dev"], command: "lunora" },
                cwd: workdir,
                json: false,
                logger: recordingLogger().logger,
                pollIntervalMs: 1,
                // The probe never confirms ready — but the "child" independently
                // supersedes the record with its authoritative info first, as the
                // vite dev-state plugin / wrangler daemon would.
                probe: async () => false,
                readyTimeoutMs: 25,
                spawnDetached: () => {
                    // `pid: process.ppid` — a genuinely alive pid (the runner's
                    // parent), like the other "child writes its own record"
                    // tests in this file use. A fake pid would itself read as
                    // stale/dead and get cleared by `readLiveDevServerState`'s
                    // own staleness check inside the poll loop, unrelated to
                    // (and masking) the behaviour under test here.
                    writeDevServerState(workdir, {
                        background: true,
                        mode: "cli",
                        pid: process.ppid,
                        studioUrl: "http://127.0.0.1:6173",
                        url: "http://localhost:9001",
                    });

                    return { exited: new Promise<number>(() => {}), pid: process.ppid };
                },
            });

            expect(result.code).toBe(1);

            const state = readDevServerState(workdir);

            // The child's own authoritative record survives untouched — the
            // parent's timeout handoff must not overwrite its real URL.
            expect(state?.pid).toBe(process.ppid);
            expect(state?.url).toBe("http://localhost:9001");
        });

        it("guards the exited-branch clear when the spawn failed before a pid was ever assigned", async () => {
            expect.assertions(2);

            // A pre-existing record owned by a totally different (but genuinely
            // alive — see the note above) process — an unguarded
            // `clearDevServerState(cwd, undefined)` would delete it.
            writeDevServerState(workdir, { mode: "cli", pid: process.ppid, url: "http://localhost:9999" });

            const result = await runDevBackground({
                command: { args: ["dev"], command: "lunora" },
                cwd: workdir,
                json: false,
                logger: recordingLogger().logger,
                pollIntervalMs: 1,
                probe: async () => false,
                readyTimeoutMs: 2000,
                spawnDetached: () => {
                    return { exited: Promise.resolve(1), pid: undefined };
                },
            });

            expect(result.code).toBe(1);
            expect(readDevServerState(workdir)?.pid).toBe(process.ppid);
        });

        it("escalates a Windows record via `taskkill` instead of a POSIX process-group signal", async () => {
            expect.assertions(2);

            writeDevServerState(workdir, { background: true, mode: "cli", pid: 4242, url: "http://localhost:8787" });

            const spawnCalls: unknown[][] = [];
            const signals: { pid: number; signal: string }[] = [];

            await runDevStop({
                alive: () => spawnCalls.length === 0,
                cwd: workdir,
                json: false,
                logger: recordingLogger().logger,
                platform: "win32",
                pollIntervalMs: 1,
                signal: (pid, signal) => {
                    signals.push({ pid, signal });
                },
                spawnSyncImpl: (command, args, options) => {
                    spawnCalls.push([command, args, options]);

                    return { status: 0 };
                },
                stopGraceMs: 5,
            });

            expect(spawnCalls).toStrictEqual([["taskkill", ["/pid", "4242", "/T", "/F"], { stdio: "ignore" }]]);
            // The initial graceful SIGTERM still goes through `signal` — only
            // the stalled-shutdown escalation itself is taskkill's job on win32.
            expect(signals).toStrictEqual([{ pid: 4242, signal: "SIGTERM" }]);
        });

        it("escalates a background record with a POSIX process-group SIGKILL regardless of host platform", async () => {
            expect.assertions(1);

            writeDevServerState(workdir, { background: true, mode: "cli", pid: 4242, url: "http://localhost:8787" });

            const signals: { pid: number; signal: string }[] = [];

            await runDevStop({
                alive: () => !signals.some((sent) => sent.signal === "SIGKILL"),
                cwd: workdir,
                json: false,
                logger: recordingLogger().logger,
                platform: "linux",
                pollIntervalMs: 1,
                signal: (pid, signal) => {
                    signals.push({ pid, signal });
                },
                spawnSyncImpl: (): never => {
                    throw new Error("spawnSyncImpl must not be invoked on POSIX");
                },
                stopGraceMs: 5,
            });

            // SIGTERM first, then the group SIGKILL (negative pid — the pgid
            // lookup on the fake pid fails and falls back to the recorded pid).
            expect(signals).toStrictEqual([
                { pid: 4242, signal: "SIGTERM" },
                { pid: -4242, signal: "SIGKILL" },
            ]);
        });

        it("keeps the record and reports failure when the force-kill does not land", async () => {
            expect.assertions(4);

            writeDevServerState(workdir, { background: true, mode: "cli", pid: 4242, url: "http://localhost:8787" });

            const spawnCalls: unknown[][] = [];
            const { lines, logger } = recordingLogger();

            const result = await runDevStop({
                // Never dies — models a win32 `taskkill` that exits non-zero
                // while the target process survives.
                alive: () => true,
                cwd: workdir,
                json: false,
                logger,
                platform: "win32",
                pollIntervalMs: 1,
                signal: () => {
                    /* graceful SIGTERM attempt — irrelevant here */
                },
                spawnSyncImpl: (command, args, options) => {
                    spawnCalls.push([command, args, options]);

                    return { status: 1 };
                },
                stopGraceMs: 5,
            });

            expect(result.code).toBe(1);
            // The taskkill escalation was attempted exactly once...
            expect(spawnCalls).toHaveLength(1);
            // ...and the record survives so a retry can still target the server.
            expect(readDevServerState(workdir)?.pid).toBe(4242);
            expect(lines.some((line) => line.level === "error" && line.message.includes("survived the force-kill"))).toBe(true);
        });
    });
});
