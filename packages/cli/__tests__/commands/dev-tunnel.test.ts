import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearDevServerState, readDevServerState, writeDevServerState } from "@lunora/config";
import { LunoraError } from "@lunora/errors";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { devFlagConflict, runDevCommand } from "../../src/commands/dev/handler";
import type { DevOptions } from "../../src/commands/dev/index";
import { runDevBackground, runDevStatus, startBackground } from "../../src/commands/dev/lifecycle";
import { signalChild, spawnLongLivedChild } from "../../src/commands/dev/supervise";
import type { DevTunnelHandle } from "../../src/commands/dev/tunnel";
import {
    buildCloudflaredArgs,
    checkCloudflared,
    CLOUDFLARED_INSTALL_URL,
    normalizeAllowMail,
    parseCloudflaredLine,
    startDevTunnel,
    startTunnelForPlan,
    waitForViteOrigin,
} from "../../src/commands/dev/tunnel";
import type { LongLivedDescriptor, LongLivedSpawner } from "../../src/commands/dev/types";
import type { Logger } from "../../src/util/logger";
import type { Spawner } from "../../src/util/spawn";

interface Recorded {
    lines: { level: keyof Logger; message: string }[];
    logger: Logger;
}

const recordingLogger = (): Recorded => {
    const lines: Recorded["lines"] = [];
    const record =
        (level: keyof Logger) =>
        (message: string): void => {
            lines.push({ level, message });
        };

    return {
        lines,
        logger: { debug: record("debug"), error: record("error"), info: record("info"), success: record("success"), warn: record("warn") },
    };
};

const TUNNEL_URL = "https://quiet-marble-otter.trycloudflare.com";
const URL_LINE = JSON.stringify({ level: "info", message: `|  ${TUNNEL_URL}                                              |`, time: "2026-10-03T10:00:00Z" });

const text = (recorded: Recorded): string => recorded.lines.map((line) => line.message).join("\n");

/** A one-shot spawner answering `cloudflared --version` — `undefined` means "not on PATH". */
const versionProbe =
    (version: string | undefined): Spawner =>
    async () => {
        if (version === undefined) {
            throw new LunoraError("LOCAL_DEPENDENCY_MISSING", "`cloudflared` is not installed or not on your PATH — nothing was run.");
        }

        return { code: 0, stdout: `cloudflared version ${version} (built 2026-09-24-1531 UTC)\n` };
    };

interface FakeChild {
    calls: LongLivedDescriptor[];
    /** Signals the child received. */
    killed: NodeJS.Signals[];
    startChild: LongLivedSpawner;
}

/**
 * A recording long-lived spawner standing in for `cloudflared tunnel`: it emits
 * `lines` on stderr and stays up until killed — or exits on its own with
 * `exitCode` when one is given.
 */
const fakeCloudflared = (lines: string[] = [URL_LINE], exitCode?: number): FakeChild => {
    const calls: LongLivedDescriptor[] = [];
    const killed: NodeJS.Signals[] = [];

    const startChild: LongLivedSpawner = (descriptor, onLine) => {
        calls.push(descriptor);

        let end: (code: number) => void = () => {};
        const exited = new Promise<number>((resolve) => {
            end = resolve;
        });

        queueMicrotask(() => {
            for (const line of lines) {
                onLine(line, "stderr");
            }

            if (exitCode !== undefined) {
                end(exitCode);
            }
        });

        return {
            exited,
            kill: (signal) => {
                killed.push(signal);
                end(0);
            },
        };
    };

    return { calls, killed, startChild };
};

/** A logger that resolves `printed` when the `Tunnel:` line is logged. */
const waitForTunnelLine = (recorded: Recorded): { logger: Logger; printed: Promise<string> } => {
    let resolvePrinted: (message: string) => void = () => {};
    const printed = new Promise<string>((resolve) => {
        resolvePrinted = resolve;
    });

    return {
        logger: {
            ...recorded.logger,
            success: (message) => {
                recorded.logger.success(message);

                if (message.includes("Tunnel:")) {
                    resolvePrinted(message);
                }
            },
        },
        printed,
    };
};

describe("lunora dev --tunnel", () => {
    let workdir: string;
    let tunnel: DevTunnelHandle | undefined;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-dev-tunnel-"));
    });

    afterEach(async () => {
        await tunnel?.close();
        tunnel = undefined;
        clearDevServerState(workdir);
        rmSync(workdir, { force: true, recursive: true });
    });

    describe(buildCloudflaredArgs, () => {
        it("opens a public quick tunnel with JSON logs when no --allow-mail is given", () => {
            expect.assertions(1);

            expect(buildCloudflaredArgs("http://localhost:8787", [])).toStrictEqual([
                "tunnel",
                "--url",
                "http://localhost:8787",
                "--output",
                "json",
                "--grace-period",
                "1s",
            ]);
        });

        it("passes every --allow-mail entry through as --allowed-mail", () => {
            expect.assertions(1);

            expect(
                buildCloudflaredArgs("http://localhost:8787", ["alice@example.com", "bob@example.com,carol@example.com", "*@example.org"]).slice(7),
            ).toStrictEqual(["--allowed-mail", "alice@example.com", "--allowed-mail", "bob@example.com,carol@example.com", "--allowed-mail", "*@example.org"]);
        });
    });

    describe(normalizeAllowMail, () => {
        it('trims entries and drops empty ones, so `--allow-mail ""` is not protection', () => {
            expect.assertions(2);

            expect(normalizeAllowMail(["", "  ", " , "])).toStrictEqual({ entries: [], invalid: [] });
            expect(normalizeAllowMail([" alice@example.com ", "bob@example.com, ,*@example.org"])).toStrictEqual({
                entries: ["alice@example.com", "bob@example.com,*@example.org"],
                invalid: [],
            });
        });

        it("reports parts without an @", () => {
            expect.assertions(1);

            expect(normalizeAllowMail(["alice@example.com,bob", "example.org"]).invalid).toStrictEqual(["bob", "example.org"]);
        });
    });

    describe(parseCloudflaredLine, () => {
        it("reads the assigned URL from a zerolog JSON line", () => {
            expect.assertions(2);

            const parsed = parseCloudflaredLine(URL_LINE);

            expect(parsed.url).toBe(TUNNEL_URL);
            expect(parsed.level).toBe("info");
        });

        it("keeps the level and message of a JSON line without a URL", () => {
            expect.assertions(1);

            expect(parseCloudflaredLine(JSON.stringify({ level: "error", message: "failed to request quick Tunnel" }))).toStrictEqual({
                level: "error",
                text: "failed to request quick Tunnel",
                url: undefined,
            });
        });

        it("falls back to scraping a line that is not JSON", () => {
            expect.assertions(2);

            const parsed = parseCloudflaredLine("2026-10-03T10:00:00Z INF |  https://abc-def.trycloudflare.com  |");

            expect(parsed.url).toBe("https://abc-def.trycloudflare.com");
            expect(parsed.level).toBeUndefined();
        });
    });

    describe(checkCloudflared, () => {
        it("accepts the minimum version and newer", async () => {
            expect.assertions(2);

            await expect(checkCloudflared(versionProbe("2026.9.3"))).resolves.toStrictEqual({ ok: true, version: "2026.9.3" });
            await expect(checkCloudflared(versionProbe("2026.10.0"))).resolves.toStrictEqual({ ok: true, version: "2026.10.0" });
        });

        it("rejects an older cloudflared with the install link", async () => {
            expect.assertions(3);

            const check = await checkCloudflared(versionProbe("2026.9.2"));

            expect(check.ok).toBe(false);
            expect(check.ok ? "" : check.message).toContain("found 2026.9.2");
            expect(check.ok ? "" : check.message).toContain(CLOUDFLARED_INSTALL_URL);
        });

        it("reports a missing cloudflared with the install link", async () => {
            expect.assertions(2);

            const check = await checkCloudflared(versionProbe(undefined));

            expect(check.ok ? "" : check.message).toContain("not on your PATH");
            expect(check.ok ? "" : check.message).toContain(CLOUDFLARED_INSTALL_URL);
        });

        it("reports a cloudflared that exists but cannot run as what happened, not as missing", async () => {
            expect.assertions(2);

            const check = await checkCloudflared(async () => {
                throw Object.assign(new Error("spawn cloudflared EACCES"), { code: "EACCES" });
            });

            expect(check.ok ? "" : check.message).toContain("EACCES");
            expect(check.ok ? "" : check.message).not.toContain("not on your PATH");
        });

        it("lets an unparseable version (a source build) through", async () => {
            expect.assertions(1);

            await expect(
                checkCloudflared(async () => {
                    return { code: 0, stdout: "cloudflared version DEV (built unknown)\n" };
                }),
            ).resolves.toStrictEqual({
                ok: true,
                version: undefined,
            });
        });
    });

    describe(startDevTunnel, () => {
        it("prints the URL and a prominent public warning without --allow-mail, and records the URL", async () => {
            expect.assertions(5);

            writeDevServerState(workdir, { mode: "cli", pid: process.pid, url: "http://localhost:8787" });

            const recorded = recordingLogger();
            const { logger, printed } = waitForTunnelLine(recorded);
            const child = fakeCloudflared();

            tunnel = startDevTunnel({
                allowMail: [],
                cwd: workdir,
                logger,
                origin: { kind: "fixed", origin: "http://localhost:8787" },
                spawner: versionProbe("2026.9.3"),
                startChild: child.startChild,
            });

            await expect(printed).resolves.toBe(`  ➜  Tunnel:     ${TUNNEL_URL}  (PUBLIC)`);
            expect(text(recorded)).toContain("PUBLIC TUNNEL: anyone with the tunnel URL can reach this dev server");
            expect(text(recorded)).toContain("lunora dev --tunnel --allow-mail you@example.com");
            expect(child.calls[0]?.args.includes("--allowed-mail")).toBe(false);
            expect(readDevServerState(workdir)?.tunnelUrl).toBe(TUNNEL_URL);
        });

        it("passes --allow-mail through, spawns cloudflared without a shell, and prints no public warning", async () => {
            expect.assertions(4);

            const recorded = recordingLogger();
            const { logger, printed } = waitForTunnelLine(recorded);
            const child = fakeCloudflared();

            tunnel = startDevTunnel({
                allowMail: ["alice@example.com", "*@example.org"],
                cwd: workdir,
                logger,
                origin: { kind: "fixed", origin: "http://localhost:8787" },
                spawner: versionProbe("2026.9.3"),
                startChild: child.startChild,
            });
            await printed;

            expect(child.calls[0]).toStrictEqual({
                args: [
                    "tunnel",
                    "--url",
                    "http://localhost:8787",
                    "--output",
                    "json",
                    "--grace-period",
                    "1s",
                    "--allowed-mail",
                    "alice@example.com",
                    "--allowed-mail",
                    "*@example.org",
                ],
                command: "cloudflared",
                direct: true,
            });
            expect(text(recorded)).not.toContain("PUBLIC");
            expect(text(recorded)).toContain("Allowed:    alice@example.com, *@example.org");
            expect(text(recorded)).not.toContain("allowedHosts");
        });

        it("stops the cloudflared child on close, without reporting it as a dead tunnel", async () => {
            expect.assertions(3);

            const recorded = recordingLogger();
            const { logger, printed } = waitForTunnelLine(recorded);
            const child = fakeCloudflared();
            const listenersBefore = process.listenerCount("SIGINT");

            tunnel = startDevTunnel({
                allowMail: [],
                cwd: workdir,
                logger,
                origin: { kind: "fixed", origin: "http://localhost:8787" },
                spawner: versionProbe("2026.9.3"),
                startChild: child.startChild,
            });
            await printed;
            await tunnel.close();

            expect(child.killed).toStrictEqual(["SIGTERM"]);
            expect(text(recorded)).not.toContain("cloudflared exited");
            // The shutdown-signal listeners are detached again.
            expect(process.listenerCount("SIGINT")).toBe(listenersBefore);
        });

        /** A cloudflared stand-in that prints the URL, then ignores the signals in `ignored`. */
        const stubbornCloudflared = (ignored: ReadonlySet<NodeJS.Signals>): FakeChild => {
            const calls: LongLivedDescriptor[] = [];
            const killed: NodeJS.Signals[] = [];

            const startChild: LongLivedSpawner = (descriptor, onLine) => {
                calls.push(descriptor);

                let end: (code: number) => void = () => {};
                const exited = new Promise<number>((resolve) => {
                    end = resolve;
                });

                queueMicrotask(() => {
                    onLine(URL_LINE, "stderr");
                });

                return {
                    exited,
                    kill: (signal) => {
                        killed.push(signal);

                        if (!ignored.has(signal)) {
                            end(1);
                        }
                    },
                };
            };

            return { calls, killed, startChild };
        };

        it("force-kills a cloudflared that ignores SIGTERM when the close timeout expires", async () => {
            expect.assertions(3);

            const recorded = recordingLogger();
            const { logger, printed } = waitForTunnelLine(recorded);
            const child = stubbornCloudflared(new Set(["SIGTERM"]));

            tunnel = startDevTunnel({
                allowMail: [],
                closeTimeoutMs: 20,
                cwd: workdir,
                logger,
                origin: { kind: "fixed", origin: "http://localhost:8787" },
                spawner: versionProbe("2026.9.3"),
                startChild: child.startChild,
            });
            await printed;
            await tunnel.close();

            expect(child.killed).toStrictEqual(["SIGTERM", "SIGKILL"]);
            expect(text(recorded)).toContain("cloudflared did not exit within 0.02s of SIGTERM — force-killing it.");
            expect(recorded.lines.filter((line) => line.level === "error")).toHaveLength(0);
        });

        it("says so when even the force-kill cannot be confirmed, so a public tunnel cannot silently outlive dev", async () => {
            expect.assertions(2);

            const recorded = recordingLogger();
            const { logger, printed } = waitForTunnelLine(recorded);
            const child = stubbornCloudflared(new Set(["SIGKILL", "SIGTERM"]));

            tunnel = startDevTunnel({
                allowMail: [],
                closeTimeoutMs: 20,
                cwd: workdir,
                logger,
                origin: { kind: "fixed", origin: "http://localhost:8787" },
                spawner: versionProbe("2026.9.3"),
                startChild: child.startChild,
            });
            await printed;
            await tunnel.close();

            expect(child.killed).toStrictEqual(["SIGTERM", "SIGKILL"]);
            expect(recorded.lines.find((line) => line.level === "error")?.message).toContain(
                "could not confirm that cloudflared stopped — the PUBLIC tunnel may still be reachable",
            );
        });

        it("treats a Ctrl-C that reaches cloudflared first as shutdown, not a dead tunnel", async () => {
            expect.assertions(2);

            const recorded = recordingLogger();
            const { logger, printed } = waitForTunnelLine(recorded);
            const child = fakeCloudflared();
            const before = new Set(process.listeners("SIGINT"));

            tunnel = startDevTunnel({
                allowMail: [],
                cwd: workdir,
                logger,
                origin: { kind: "fixed", origin: "http://localhost:8787" },
                spawner: versionProbe("2026.9.3"),
                startChild: child.startChild,
            });
            await printed;

            // The terminal delivers SIGINT to the whole process group, so
            // cloudflared goes down while teardown has not reached `close()` yet.
            // Invoke the tunnel's own listener rather than emitting the signal
            // process-wide, which would reach the test runner's handlers too.
            const onSigint = process.listeners("SIGINT").find((listener) => !before.has(listener));

            onSigint?.("SIGINT");

            await expect.poll(() => child.killed).toStrictEqual(["SIGTERM"]);

            expect(text(recorded)).not.toContain("the dev server keeps running");
        });

        it("carries on without a tunnel when cloudflared is missing", async () => {
            expect.assertions(2);

            const recorded = recordingLogger();
            const child = fakeCloudflared();

            tunnel = startDevTunnel({
                allowMail: [],
                cwd: workdir,
                logger: recorded.logger,
                origin: { kind: "fixed", origin: "http://localhost:8787" },
                spawner: versionProbe(undefined),
                startChild: child.startChild,
            });

            await expect.poll(() => text(recorded)).toContain("continuing without a tunnel");
            // Only the version probe ran — no tunnel was attempted.
            expect(child.calls).toHaveLength(0);
        });

        it("carries on without a tunnel when cloudflared is too old", async () => {
            expect.assertions(2);

            const recorded = recordingLogger();
            const child = fakeCloudflared();

            tunnel = startDevTunnel({
                allowMail: ["alice@example.com"],
                cwd: workdir,
                logger: recorded.logger,
                origin: { kind: "fixed", origin: "http://localhost:8787" },
                spawner: versionProbe("2025.11.1"),
                startChild: child.startChild,
            });

            await expect.poll(() => recorded.lines.find((line) => line.level === "error")?.message).toContain("needs `cloudflared` 2026.9.3 or newer");
            expect(child.calls).toHaveLength(0);
        });

        it("warns when cloudflared exits before assigning a URL, and surfaces its error lines", async () => {
            expect.assertions(2);

            const recorded = recordingLogger();
            const child = fakeCloudflared([JSON.stringify({ level: "error", message: '"invalid" is not a valid email address' })], 1);

            tunnel = startDevTunnel({
                allowMail: ["invalid@"],
                cwd: workdir,
                logger: recorded.logger,
                origin: { kind: "fixed", origin: "http://localhost:8787" },
                spawner: versionProbe("2026.9.3"),
                startChild: child.startChild,
            });

            await expect.poll(() => text(recorded)).toContain("cloudflared exited (1) before a tunnel URL was assigned — continuing without a tunnel.");
            expect(text(recorded)).toContain('[cloudflared] "invalid" is not a valid email address');
        });
    });

    describe(waitForViteOrigin, () => {
        it("resolves with the URL and PID @lunora/vite records, ignoring the CLI's provisional record", async () => {
            expect.assertions(1);

            writeDevServerState(workdir, { mode: "cli", pid: process.pid, url: "http://localhost:5173" });
            setTimeout(() => {
                writeDevServerState(workdir, { mode: "vite", pid: process.pid, url: "http://localhost:5174" });
            }, 30);

            await expect(
                waitForViteOrigin(workdir, recordingLogger().logger, new AbortController().signal, { intervalMs: 10, timeoutMs: 2000 }),
            ).resolves.toStrictEqual({
                origin: "http://localhost:5174",
                ownerPid: process.pid,
            });
        });

        it("gives up after the timeout and says why", async () => {
            expect.assertions(2);

            const recorded = recordingLogger();

            await expect(waitForViteOrigin(workdir, recorded.logger, new AbortController().signal, { intervalMs: 10, timeoutMs: 50 })).resolves.toBeUndefined();
            expect(text(recorded)).toContain("did not report its URL");
        });

        it("stops quietly when aborted", async () => {
            expect.assertions(2);

            const recorded = recordingLogger();
            const controller = new AbortController();
            const waiting = waitForViteOrigin(workdir, recorded.logger, controller.signal, { intervalMs: 1000, timeoutMs: 60_000 });

            controller.abort();

            await expect(waiting).resolves.toBeUndefined();
            expect(recorded.lines).toHaveLength(0);
        });
    });

    describe(startTunnelForPlan, () => {
        it("starts nothing without a tunnel request", () => {
            expect.assertions(1);

            expect(
                startTunnelForPlan({
                    cwd: workdir,
                    logger: recordingLogger().logger,
                    plan: { flavor: "wrangler", workerOrigin: "http://localhost:8787" },
                    tunnel: undefined,
                }),
            ).toBeUndefined();
        });

        it("tunnels the URL Vite records on the vite flavor — not the pre-listen guess — with the allowedHosts hint", async () => {
            expect.assertions(3);

            writeDevServerState(workdir, { mode: "vite", pid: process.pid, url: "http://localhost:5174" });

            const recorded = recordingLogger();
            const { logger, printed } = waitForTunnelLine(recorded);
            const child = fakeCloudflared();

            tunnel = startTunnelForPlan({
                cwd: workdir,
                logger,
                plan: { flavor: "vite", workerOrigin: "http://localhost:5173" },
                tunnel: { allowMail: [], spawner: versionProbe("2026.9.3"), startChild: child.startChild },
            });
            await printed;

            expect(child.calls[0]?.args.slice(0, 3)).toStrictEqual(["tunnel", "--url", "http://localhost:5174"]);
            expect(text(recorded)).toContain('allowedHosts: [".trycloudflare.com"]');
            expect(readDevServerState(workdir)?.tunnelUrl).toBe(TUNNEL_URL);
        });
    });

    describe("runDevCommand", () => {
        it("tunnels the worker origin — never the studio port — and stops cloudflared when dev exits", async () => {
            expect.assertions(3);

            const recorded = recordingLogger();
            const child = fakeCloudflared();
            let endWorker: (code: number) => void = () => {};
            const logger: Logger = {
                ...recorded.logger,
                success: (message) => {
                    recorded.logger.success(message);

                    if (message.includes("Tunnel:")) {
                        endWorker(0);
                    }
                },
            };

            const result = await runDevCommand({
                codegen: false,
                cwd: workdir,
                findFreePort: async () => 8787,
                logger,
                startStudio: async () => {
                    return { close: async () => {}, url: "http://127.0.0.1:6173" };
                },
                startWorker: () => {
                    return {
                        exited: new Promise<number>((resolve) => {
                            endWorker = resolve;
                        }),
                        kill: () => {},
                    };
                },
                tunnel: { allowMail: [], spawner: versionProbe("2026.9.3"), startChild: child.startChild },
            });

            expect(result.code).toBe(0);
            expect(child.calls[0]?.args.slice(0, 3)).toStrictEqual(["tunnel", "--url", "http://localhost:8787"]);
            expect(child.killed).toStrictEqual(["SIGTERM"]);
        });
    });

    describe(devFlagConflict, () => {
        const base = { allowMail: undefined, local: undefined, remote: undefined, tunnel: undefined };

        it("refuses --allow-mail without --tunnel, and accepts it with one", () => {
            expect.assertions(2);

            expect(devFlagConflict({ ...base, allowMail: ["alice@example.com"] })).toContain("add `--tunnel`");
            expect(devFlagConflict({ ...base, allowMail: ["alice@example.com"], tunnel: true })).toBeUndefined();
        });

        it("refuses an entry that is not an email address", () => {
            expect.assertions(1);

            expect(devFlagConflict({ ...base, allowMail: ["alice@example.com,bob"], tunnel: true })).toContain('not "bob"');
        });

        it("ignores an empty --allow-mail rather than counting it as protection", () => {
            expect.assertions(1);

            expect(devFlagConflict({ ...base, allowMail: [""] })).toBeUndefined();
        });
    });

    describe("background mode", () => {
        afterEach(() => {
            clearDevServerState(workdir, process.pid);
        });

        const startRecording = async (options: Partial<DevOptions>): Promise<{ args: ReadonlyArray<string>; tunnel?: boolean }[]> => {
            const seen: { args: ReadonlyArray<string>; tunnel?: boolean }[] = [];

            await startBackground({
                cwd: workdir,
                jsonLogs: false,
                logger: recordingLogger().logger,
                options: options as DevOptions,
                remote: false,
                run: async (run) => {
                    seen.push({ args: run.command.args, tunnel: run.tunnel });

                    return { code: 0 };
                },
            });

            return seen;
        };

        it("forwards --tunnel and every --allow-mail to the daemon", async () => {
            expect.assertions(2);

            const [seen] = await startRecording({ allowMail: ["alice@example.com", "*@example.org"], tunnel: true });

            // An unforwarded --allow-mail would turn a protected tunnel public in the daemon.
            expect(seen?.args.slice(seen.args.indexOf("--tunnel"))).toStrictEqual([
                "--tunnel",
                "--allow-mail",
                "alice@example.com",
                "--allow-mail",
                "*@example.org",
            ]);
            expect(seen?.tunnel).toBe(true);
        });

        it("runs a tunneled Vite project through the daemon, which owns cloudflared, instead of the bare Vite script", async () => {
            expect.assertions(3);

            writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies: { "@lunora/vite": "1.0.0" }, name: "app" }), "utf8");
            writeFileSync(join(workdir, "vite.config.ts"), "export default {};\n", "utf8");

            const [tunneled] = await startRecording({ allowMail: ["alice@example.com"], tunnel: true });

            clearDevServerState(workdir, process.pid);

            const [plain] = await startRecording({});

            expect(tunneled?.args).toContain("--tunnel");
            expect(tunneled?.args[0]).toBe(process.argv[1] ?? "lunora");
            // Without --tunnel the Vite dev script still runs directly.
            expect(plain?.args).not.toContain("--tunnel");
        });

        it("prints the tunnel URL the daemon records once the server is ready", async () => {
            expect.assertions(1);

            const recorded = recordingLogger();

            await runDevBackground({
                command: { args: [], command: "unused" },
                cwd: workdir,
                json: false,
                logger: recorded.logger,
                pollIntervalMs: 10,
                probe: async () => true,
                spawnDetached: () => {
                    // The "daemon": records itself, then the tunnel URL a moment later.
                    writeDevServerState(workdir, { mode: "cli", pid: process.ppid, url: "http://localhost:8787" });
                    setTimeout(() => {
                        writeDevServerState(workdir, { mode: "cli", pid: process.ppid, tunnelUrl: TUNNEL_URL, url: "http://localhost:8787" });
                    }, 30);

                    return { exited: new Promise<number>(() => {}), pid: process.ppid };
                },
                tunnel: true,
                tunnelUrlTimeoutMs: 2000,
            });

            expect(recorded.lines).toContainEqual({ level: "success", message: `  Tunnel: ${TUNNEL_URL}` });
        });

        it("points at status and logs when the tunnel URL has not arrived", async () => {
            expect.assertions(1);

            const recorded = recordingLogger();

            await runDevBackground({
                command: { args: [], command: "unused" },
                cwd: workdir,
                json: false,
                logger: recorded.logger,
                pollIntervalMs: 10,
                probe: async () => true,
                spawnDetached: () => {
                    writeDevServerState(workdir, { mode: "cli", pid: process.ppid, url: "http://localhost:8787" });

                    return { exited: new Promise<number>(() => {}), pid: process.ppid };
                },
                tunnel: true,
                tunnelUrlTimeoutMs: 50,
            });

            expect(text(recorded)).toContain("`lunora dev status` shows it once cloudflared reports one; `lunora dev logs`");
        });

        it("shows the tunnel URL in `lunora dev status`", () => {
            expect.assertions(1);

            writeDevServerState(workdir, { mode: "cli", pid: process.pid, tunnelUrl: TUNNEL_URL, url: "http://localhost:8787" });

            const recorded = recordingLogger();

            runDevStatus({ cwd: workdir, json: false, logger: recorded.logger });

            expect(text(recorded)).toContain(`Tunnel: ${TUNNEL_URL}`);
        });
    });

    describe(signalChild, () => {
        it("force-kills the whole tree with taskkill on Windows, and signals directly elsewhere", () => {
            expect.assertions(3);

            const sent: NodeJS.Signals[] = [];
            const taskkill: ReadonlyArray<string>[] = [];
            const child = {
                kill: (signal?: NodeJS.Signals | number) => {
                    sent.push(signal as NodeJS.Signals);

                    return true;
                },
                pid: 4321,
            };
            const spawnSyncImpl = (command: string, args: ReadonlyArray<string>): void => {
                taskkill.push([command, ...args]);
            };

            signalChild(child, "SIGKILL", "win32", spawnSyncImpl);
            signalChild(child, "SIGTERM", "win32", spawnSyncImpl);
            signalChild(child, "SIGKILL", "linux", spawnSyncImpl);

            expect(taskkill).toStrictEqual([["taskkill", "/pid", "4321", "/T", "/F"]]);
            // SIGTERM on Windows, and SIGKILL elsewhere, go to the child itself.
            expect(sent).toStrictEqual(["SIGTERM", "SIGKILL"]);
            expect(taskkill).toHaveLength(1);
        });
    });

    describe(spawnLongLivedChild, () => {
        it("decodes a multi-byte character split across two output chunks", async () => {
            expect.assertions(1);

            const lines: string[] = [];
            // "é" is 0xC3 0xA9; its two bytes are written in separate chunks.
            const child = spawnLongLivedChild(
                {
                    args: [
                        "-e",
                        String.raw`process.stderr.write(Buffer.from([0x63, 0x61, 0x66, 0xc3])); setTimeout(() => process.stderr.write(Buffer.from([0xa9, 0x0a])), 50);`,
                    ],
                    command: process.execPath,
                    direct: true,
                },
                (line) => {
                    lines.push(line);
                },
            );

            await child.exited;

            await expect.poll(() => lines).toStrictEqual(["café"]);
        });

        it("hands over each output line — split chunks rejoined — and stops on kill", async () => {
            expect.assertions(2);

            const lines: string[] = [];
            const child = spawnLongLivedChild(
                {
                    args: [
                        "-e",
                        String.raw`process.stderr.write("first li"); setTimeout(() => process.stderr.write("ne\nsecond\n"), 50); setInterval(() => {}, 1000);`,
                    ],
                    command: process.execPath,
                    direct: true,
                },
                (line) => {
                    lines.push(line);

                    if (lines.length === 2) {
                        child.kill("SIGTERM");
                    }
                },
            );

            const code = await child.exited;

            expect(lines).toStrictEqual(["first line", "second"]);
            // Killed by a signal: reported as a failure code.
            expect(code).toBe(1);
        });
    });
});
