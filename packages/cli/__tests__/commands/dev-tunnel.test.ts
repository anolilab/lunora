import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearDevServerState } from "@lunora/config";
import { LunoraError } from "@lunora/errors";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { devFlagConflict, runDevCommand } from "../../src/commands/dev/handler";
import type { DevOptions } from "../../src/commands/dev/index";
import { startBackground } from "../../src/commands/dev/lifecycle";
import type { DevTunnelHandle } from "../../src/commands/dev/tunnel";
import { buildCloudflaredArgs, checkCloudflared, CLOUDFLARED_INSTALL_URL, parseCloudflaredLine, startDevTunnel } from "../../src/commands/dev/tunnel";
import type { Logger } from "../../src/util/logger";
import type { SpawnDescriptor, SpawnResult } from "../../src/util/spawn";
import { createRecordingSpawner } from "../../src/util/spawn";

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

const URL_LINE = JSON.stringify({
    level: "info",
    message: "|  https://quiet-marble-otter.trycloudflare.com                                              |",
    time: "2026-10-03T10:00:00Z",
});

/**
 * A recording spawner that answers `cloudflared --version` with `version`, and
 * runs the tunnel as a long-lived child: it emits `tunnelLines` on stderr, then
 * stays up until its `signal` aborts — like the real child under dev.
 */
const cloudflaredSpawner = (version: string | undefined, tunnelLines: string[] = [URL_LINE]): ReturnType<typeof createRecordingSpawner> =>
    createRecordingSpawner(0, async (descriptor: SpawnDescriptor): Promise<SpawnResult> => {
        if (descriptor.args[0] === "--version") {
            if (version === undefined) {
                throw new LunoraError("LOCAL_DEPENDENCY_MISSING", "`cloudflared` is not installed or not on your PATH — nothing was run.");
            }

            return { code: 0, stdout: `cloudflared version ${version} (built 2026-09-24-1531 UTC)\n` };
        }

        for (const line of tunnelLines) {
            descriptor.onStderrLine?.(line);
        }

        return await new Promise<SpawnResult>((resolve) => {
            descriptor.signal?.addEventListener("abort", () => {
                resolve({ code: 0 });
            });
        });
    });

const text = (recorded: Recorded): string => recorded.lines.map((line) => line.message).join("\n");

describe("lunora dev --tunnel", () => {
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

        it("passes every --allow-mail value through verbatim as --allowed-mail", () => {
            expect.assertions(1);

            expect(
                buildCloudflaredArgs("http://localhost:8787", ["alice@example.com", "bob@example.com,carol@example.com", "*@example.org"]).slice(7),
            ).toStrictEqual(["--allowed-mail", "alice@example.com", "--allowed-mail", "bob@example.com,carol@example.com", "--allowed-mail", "*@example.org"]);
        });
    });

    describe(parseCloudflaredLine, () => {
        it("reads the assigned URL from a zerolog JSON line", () => {
            expect.assertions(2);

            const parsed = parseCloudflaredLine(URL_LINE);

            expect(parsed.url).toBe("https://quiet-marble-otter.trycloudflare.com");
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

            await expect(checkCloudflared(cloudflaredSpawner("2026.9.3").spawner)).resolves.toStrictEqual({ ok: true, version: "2026.9.3" });
            await expect(checkCloudflared(cloudflaredSpawner("2026.10.0").spawner)).resolves.toStrictEqual({ ok: true, version: "2026.10.0" });
        });

        it("rejects an older cloudflared with the install link", async () => {
            expect.assertions(3);

            const check = await checkCloudflared(cloudflaredSpawner("2026.9.2").spawner);

            expect(check.ok).toBe(false);
            expect(check.ok ? "" : check.message).toContain("found 2026.9.2");
            expect(check.ok ? "" : check.message).toContain(CLOUDFLARED_INSTALL_URL);
        });

        it("reports a missing cloudflared with the install link", async () => {
            expect.assertions(2);

            const check = await checkCloudflared(cloudflaredSpawner(undefined).spawner);

            expect(check.ok ? "" : check.message).toContain("not on your PATH");
            expect(check.ok ? "" : check.message).toContain(CLOUDFLARED_INSTALL_URL);
        });

        it("lets an unparseable version (a source build) through", async () => {
            expect.assertions(1);

            const { spawner } = createRecordingSpawner(0, () => {
                return { code: 0, stdout: "cloudflared version DEV (built unknown)\n" };
            });

            await expect(checkCloudflared(spawner)).resolves.toStrictEqual({ ok: true, version: undefined });
        });
    });

    describe(startDevTunnel, () => {
        let tunnel: DevTunnelHandle | undefined;

        afterEach(async () => {
            await tunnel?.close();
            tunnel = undefined;
        });

        it("prints the URL and a prominent public warning without --allow-mail", async () => {
            expect.assertions(5);

            const recorded = recordingLogger();
            const { calls, spawner } = cloudflaredSpawner("2026.9.3");

            tunnel = startDevTunnel({ allowMail: [], logger: recorded.logger, origin: "http://localhost:8787", spawner });

            await expect(tunnel.url).resolves.toBe("https://quiet-marble-otter.trycloudflare.com");
            expect(recorded.lines).toContainEqual({ level: "success", message: "  ➜  Tunnel:     https://quiet-marble-otter.trycloudflare.com  (PUBLIC)" });

            const warnings = recorded.lines.filter((line) => line.level === "warn").map((line) => line.message);

            expect(warnings.join("\n")).toContain("PUBLIC TUNNEL: anyone with the tunnel URL can reach this dev server");
            expect(warnings.join("\n")).toContain("lunora dev --tunnel --allow-mail you@example.com");
            expect(calls.map((call) => call.descriptor.args.includes("--allowed-mail"))).toStrictEqual([false, false]);
        }, 10_000);

        it("passes --allow-mail through and prints no public warning", async () => {
            expect.assertions(4);

            const recorded = recordingLogger();
            const { calls, spawner } = cloudflaredSpawner("2026.9.3");
            let resolveUrl: (() => void) | undefined;
            const urlPrinted = new Promise<void>((resolve) => {
                resolveUrl = resolve;
            });
            const logger: Logger = {
                ...recorded.logger,
                success: (message) => {
                    recorded.logger.success(message);
                    resolveUrl?.();
                },
            };

            tunnel = startDevTunnel({ allowMail: ["alice@example.com", "*@example.org"], logger, origin: "http://localhost:8787", spawner });
            await urlPrinted;

            const tunnelCall = calls[1]?.descriptor;

            expect(tunnelCall?.command).toBe("cloudflared");
            expect(tunnelCall?.args).toStrictEqual([
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
            ]);
            expect(text(recorded)).not.toContain("PUBLIC");
            expect(text(recorded)).toContain("Allowed:    alice@example.com, *@example.org");
        });

        it("stops the cloudflared child on close", async () => {
            expect.assertions(2);

            const { calls, spawner } = cloudflaredSpawner("2026.9.3");
            const recorded = recordingLogger();

            tunnel = startDevTunnel({ allowMail: [], logger: recorded.logger, origin: "http://localhost:8787", spawner });

            await expect.poll(() => calls.length).toBe(2);

            await tunnel.close();

            expect(calls[1]?.descriptor.signal?.aborted).toBe(true);
        });

        it("carries on without a tunnel when cloudflared is missing", async () => {
            expect.assertions(3);

            const recorded = recordingLogger();
            const { calls, spawner } = cloudflaredSpawner(undefined);

            tunnel = startDevTunnel({ allowMail: [], logger: recorded.logger, origin: "http://localhost:8787", spawner });

            await expect(tunnel.url).resolves.toBeUndefined();
            // Only the version probe ran — no tunnel was attempted.
            expect(calls).toHaveLength(1);
            expect(text(recorded)).toContain("continuing without a tunnel");
        });

        it("carries on without a tunnel when cloudflared is too old", async () => {
            expect.assertions(3);

            const recorded = recordingLogger();
            const { calls, spawner } = cloudflaredSpawner("2025.11.1");

            tunnel = startDevTunnel({ allowMail: ["alice@example.com"], logger: recorded.logger, origin: "http://localhost:8787", spawner });

            await expect(tunnel.url).resolves.toBeUndefined();
            expect(calls).toHaveLength(1);
            expect(recorded.lines.find((line) => line.level === "error")?.message).toContain("needs `cloudflared` 2026.9.3 or newer");
        });

        it("warns when cloudflared exits before assigning a URL, and surfaces its error lines", async () => {
            expect.assertions(3);

            const recorded = recordingLogger();
            const { spawner } = createRecordingSpawner(0, (descriptor) => {
                if (descriptor.args[0] === "--version") {
                    return { code: 0, stdout: "cloudflared version 2026.9.3\n" };
                }

                descriptor.onStderrLine?.(JSON.stringify({ level: "error", message: '"invalid" is not a valid email address' }));

                return { code: 1 };
            });

            tunnel = startDevTunnel({ allowMail: ["invalid"], logger: recorded.logger, origin: "http://localhost:8787", spawner });

            await expect(tunnel.url).resolves.toBeUndefined();
            expect(text(recorded)).toContain('[cloudflared] "invalid" is not a valid email address');
            expect(text(recorded)).toContain("cloudflared exited (1) before a tunnel URL was assigned — continuing without a tunnel.");
        });
    });

    describe("runDevCommand", () => {
        let workdir: string;

        beforeEach(() => {
            workdir = mkdtempSync(join(tmpdir(), "lunora-cli-dev-tunnel-"));
        });

        afterEach(() => {
            rmSync(workdir, { force: true, recursive: true });
        });

        it("tunnels the worker origin — never the studio port — and stops cloudflared when dev exits", async () => {
            expect.assertions(4);

            const recorded = recordingLogger();
            const { calls, spawner } = cloudflaredSpawner("2026.9.3");
            let endWorker: ((code: number) => void) | undefined;
            const logger: Logger = {
                ...recorded.logger,
                success: (message) => {
                    recorded.logger.success(message);

                    if (message.includes("Tunnel:")) {
                        endWorker?.(0);
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
                tunnel: true,
                tunnelSpawner: spawner,
            });

            const tunnelCall = calls[1]?.descriptor;

            expect(result.code).toBe(0);
            expect(tunnelCall?.args.slice(0, 3)).toStrictEqual(["tunnel", "--url", "http://localhost:8787"]);
            expect(tunnelCall?.args.join(" ")).not.toContain("6173");
            expect(tunnelCall?.signal?.aborted).toBe(true);
        });
    });

    describe(devFlagConflict, () => {
        it("refuses --allow-mail without --tunnel, and accepts it with one", () => {
            expect.assertions(3);

            expect(devFlagConflict({ allowMail: ["alice@example.com"], local: undefined, remote: undefined, tunnel: undefined })).toContain("add `--tunnel`");
            expect(devFlagConflict({ allowMail: ["alice@example.com"], local: undefined, remote: undefined, tunnel: true })).toBeUndefined();
            expect(devFlagConflict({ allowMail: undefined, local: undefined, remote: undefined, tunnel: true })).toBeUndefined();
        });
    });

    describe("background mode", () => {
        let workdir: string;

        beforeEach(() => {
            workdir = mkdtempSync(join(tmpdir(), "lunora-cli-dev-tunnel-bg-"));
        });

        afterEach(() => {
            clearDevServerState(workdir, process.pid);
            rmSync(workdir, { force: true, recursive: true });
        });

        it("forwards --tunnel and every --allow-mail to the daemon", async () => {
            expect.assertions(1);

            const seen: ReadonlyArray<string>[] = [];

            await startBackground({
                cwd: workdir,
                jsonLogs: false,
                logger: recordingLogger().logger,
                options: { allowMail: ["alice@example.com", "*@example.org"], tunnel: true } as DevOptions,
                remote: false,
                run: async (options: { command: { args: ReadonlyArray<string> } }) => {
                    seen.push(options.command.args);

                    return { code: 0 };
                },
            });

            // An unforwarded --allow-mail would turn a protected tunnel public in the daemon.
            expect(seen[0]?.slice(seen[0].indexOf("--tunnel"))).toStrictEqual([
                "--tunnel",
                "--allow-mail",
                "alice@example.com",
                "--allow-mail",
                "*@example.org",
            ]);
        });
    });
});
