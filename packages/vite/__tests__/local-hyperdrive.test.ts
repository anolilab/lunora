import type { Plugin } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import localHyperdrive from "../src/local-hyperdrive";

type Start = NonNullable<Parameters<typeof localHyperdrive>[0]["start"]>;

/** Run the plugin's `config` hook the way Vite does for `vite dev` or `vite build`. */
const runConfigHook = async (plugin: Plugin, command: "build" | "serve", isPreview = false): Promise<void> => {
    const hook = plugin.config;
    const run = typeof hook === "function" ? hook : hook?.handler;

    await run?.call({} as never, {} as never, { command, isPreview, mode: "development" } as never);
};

/** A dev server that only knows how to close. Returns the function that closes it. */
const attachServer = (plugin: Plugin): (() => void) => {
    let close = (): void => {};
    const httpServer = {
        once: (_event: string, listener: () => void) => {
            close = listener;
        },
    };
    const hook = plugin.configureServer;
    const run = typeof hook === "function" ? hook : hook?.handler;

    const result: unknown = run?.call({} as never, { httpServer } as never);

    if (result !== undefined) {
        throw new Error("configureServer is expected to be synchronous");
    }

    return () => {
        close();
    };
};

/** A starter that serves the bindings in `queue`, one entry per call, and records what it stopped. */
const starter = (...queue: string[][]) => {
    const stopped: string[] = [];
    const start = vi.fn<Start>(async () => {
        const bindings = queue.shift();

        return bindings === undefined
            ? undefined
            : {
                  bindings,
                  stop: async () => {
                      stopped.push(bindings.join(","));
                  },
              };
    });

    return { start, stopped };
};

describe(localHyperdrive, () => {
    let info: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        info = vi.spyOn(console, "info").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("starts the embedded Postgres for a dev server, before the Cloudflare plugin resolves bindings", async () => {
        expect.assertions(2);

        const { start } = starter(["HYPERDRIVE"]);

        await runConfigHook(localHyperdrive({ projectRoot: "/project/serve", start }), "serve");

        expect(start).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: "/project/serve" }));
        expect(localHyperdrive({ projectRoot: "/x", start }).enforce).toBe("pre");
    });

    it("starts nothing for a production build or a preview, whose output is the deploy config", async () => {
        expect.assertions(1);

        const { start } = starter(["HYPERDRIVE"]);
        const plugin = localHyperdrive({ projectRoot: "/project/build", start });

        await runConfigHook(plugin, "build");
        await runConfigHook(plugin, "serve", true);

        expect(start).not.toHaveBeenCalled();
    });

    it("asks again on every config resolution, so a binding added after the first start gets a database on reload", async () => {
        expect.assertions(2);

        const { start } = starter(["HYPERDRIVE"], ["ANALYTICS"]);
        const plugin = localHyperdrive({ projectRoot: "/project/reload", start });

        await runConfigHook(plugin, "serve");
        await runConfigHook(plugin, "serve");

        expect(start).toHaveBeenCalledTimes(2);
        expect(info).toHaveBeenCalledWith(expect.stringContaining("ANALYTICS"));
    });

    it("never starts the same binding twice when two config resolutions overlap", async () => {
        expect.assertions(1);

        let running = 0;
        let overlapped = false;
        const start = vi.fn<Start>(async () => {
            running += 1;
            overlapped ||= running > 1;
            await Promise.resolve();
            running -= 1;

            return undefined;
        });
        const plugin = localHyperdrive({ projectRoot: "/project/overlap", start });

        await Promise.all([runConfigHook(plugin, "serve"), runConfigHook(plugin, "serve")]);

        expect(overlapped).toBe(false);
    });

    it("stops the databases a little after the last server closes, and not when one is still open", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const { start, stopped } = starter(["HYPERDRIVE"]);
        const plugin = localHyperdrive({ projectRoot: "/project/close", start });

        await runConfigHook(plugin, "serve");

        const closeFirst = attachServer(plugin);
        const closeSecond = attachServer(plugin);

        closeFirst();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(stopped).toStrictEqual([]);

        closeSecond();
        await vi.advanceTimersByTimeAsync(1000);

        expect(stopped).toStrictEqual([]);

        await vi.advanceTimersByTimeAsync(10_000);

        expect(stopped).toStrictEqual(["HYPERDRIVE"]);
    });

    it("stops the databases when a middleware-mode server, which has no httpServer, closes", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const { start, stopped } = starter(["HYPERDRIVE"]);
        const plugin = localHyperdrive({ projectRoot: "/project/middleware", start });
        const environment = {};

        await runConfigHook(plugin, "serve");

        const configure = plugin.configureServer;
        const run = typeof configure === "function" ? configure : configure?.handler;

        await Promise.resolve(run?.call({} as never, { environments: { client: environment }, httpServer: null } as never));
        await vi.advanceTimersByTimeAsync(10_000);

        expect(stopped).toStrictEqual([]);

        const end = plugin.buildEnd;
        const runEnd = typeof end === "function" ? end : end?.handler;

        await Promise.resolve(runEnd?.call({ environment } as never));
        // A second delivery of the same close is a no-op.
        await Promise.resolve(runEnd?.call({ environment } as never));
        await vi.advanceTimersByTimeAsync(10_000);

        expect(stopped).toStrictEqual(["HYPERDRIVE"]);
    });

    it("keeps the databases across a restart, where the new server comes up before the old one's countdown ends", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        const { start, stopped } = starter(["HYPERDRIVE"]);
        const plugin = localHyperdrive({ projectRoot: "/project/restart", start });

        await runConfigHook(plugin, "serve");

        const closeOld = attachServer(plugin);

        closeOld();
        await vi.advanceTimersByTimeAsync(1000);
        attachServer(plugin);
        await vi.advanceTimersByTimeAsync(20_000);

        expect(stopped).toStrictEqual([]);
    });

    it("stops a database whose startup was still running when the last server's countdown ended", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        let finishSecond: () => void = () => {};
        let calls = 0;
        const stopped: string[] = [];
        const start = vi.fn<Start>(async () => {
            calls += 1;

            if (calls === 1) {
                return {
                    bindings: ["HYPERDRIVE"],
                    stop: async () => {
                        stopped.push("HYPERDRIVE");
                    },
                };
            }

            await new Promise<void>((resolve) => {
                finishSecond = resolve;
            });

            return {
                bindings: ["ANALYTICS"],
                stop: async () => {
                    stopped.push("ANALYTICS");
                },
            };
        });
        const plugin = localHyperdrive({ projectRoot: "/project/slow-restart", start });

        await runConfigHook(plugin, "serve");
        attachServer(plugin)();

        // A replacement config starts a second database, slowly, after the last server has closed.
        const second = runConfigHook(plugin, "serve");

        await vi.advanceTimersByTimeAsync(10_000);

        expect(stopped).toStrictEqual([]);

        finishSecond();
        await second;
        // The startup is done and no server came: the countdown runs again, then stops both databases.
        await vi.advanceTimersByTimeAsync(40_000);

        expect(stopped.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["ANALYTICS", "HYPERDRIVE"]);
    });

    it("keeps the databases when a server has come back by the time a slow startup finishes", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        let finishSecond: () => void = () => {};
        let calls = 0;
        const stopped: string[] = [];
        const start = vi.fn<Start>(async () => {
            calls += 1;

            if (calls > 1) {
                await new Promise<void>((resolve) => {
                    finishSecond = resolve;
                });
            }

            return {
                bindings: [`DB${String(calls)}`],
                stop: async () => {
                    stopped.push(`DB${String(calls)}`);
                },
            };
        });
        const plugin = localHyperdrive({ projectRoot: "/project/slow-return", start });

        await runConfigHook(plugin, "serve");
        attachServer(plugin)();

        const second = runConfigHook(plugin, "serve");

        await vi.advanceTimersByTimeAsync(10_000);
        // The replacement server arrives while its database is still starting.
        attachServer(plugin);
        finishSecond();
        await second;
        await vi.advanceTimersByTimeAsync(10_000);

        expect(stopped).toStrictEqual([]);
    });

    it("retries after a failed startup, instead of failing every later config resolution", async () => {
        expect.assertions(3);

        let calls = 0;
        const start = vi.fn<Start>(async () => {
            calls += 1;

            if (calls === 1) {
                throw new Error("could not read wrangler.jsonc");
            }

            return { bindings: ["HYPERDRIVE"], stop: async () => {} };
        });
        const plugin = localHyperdrive({ projectRoot: "/project/retry", start });

        await expect(runConfigHook(plugin, "serve")).rejects.toThrow("could not read wrangler.jsonc");
        await expect(runConfigHook(plugin, "serve")).resolves.toBeUndefined();

        expect(start).toHaveBeenCalledTimes(2);
    });

    it("starts a config resolved during a shutdown only after the shutdown has finished", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        let finishStop: () => void = () => {};
        let calls = 0;
        const start = vi.fn<Start>(async () => {
            calls += 1;

            return {
                bindings: [`DB${String(calls)}`],
                stop: async () => {
                    await new Promise<void>((resolve) => {
                        finishStop = resolve;
                    });
                },
            };
        });
        const plugin = localHyperdrive({ projectRoot: "/project/stopping", start });

        await runConfigHook(plugin, "serve");
        attachServer(plugin)();
        // The countdown ends and the first database begins to stop, slowly.
        await vi.advanceTimersByTimeAsync(10_000);

        const replacement = runConfigHook(plugin, "serve");

        await vi.advanceTimersByTimeAsync(0);

        expect(start).toHaveBeenCalledTimes(1);

        finishStop();
        await replacement;

        expect(start).toHaveBeenCalledTimes(2);
        expect(info).toHaveBeenCalledWith(expect.stringContaining("DB2"));
    });

    it("calls off the stop countdown as soon as a replacement config starts resolving, even if it takes longer than the countdown", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        let finishSecond: () => void = () => {};
        let calls = 0;
        const stopped: string[] = [];
        const start = vi.fn<Start>(async () => {
            calls += 1;

            if (calls > 1) {
                await new Promise<void>((resolve) => {
                    finishSecond = resolve;
                });
            }

            return {
                bindings: [`DB${String(calls)}`],
                stop: async () => {
                    stopped.push(`DB${String(calls)}`);
                },
            };
        });
        const plugin = localHyperdrive({ projectRoot: "/project/slow-start", start });

        await runConfigHook(plugin, "serve");
        attachServer(plugin)();
        // The old server has closed and its countdown runs; a replacement config starts, and takes longer than the countdown.
        await vi.advanceTimersByTimeAsync(2000);

        const second = runConfigHook(plugin, "serve");

        await vi.advanceTimersByTimeAsync(20_000);

        expect(stopped).toStrictEqual([]);

        finishSecond();
        await second;
        attachServer(plugin);
        await vi.advanceTimersByTimeAsync(20_000);

        expect(stopped).toStrictEqual([]);
    });

    it("keeps the databases while the rest of the config resolution runs, longer than the countdown after a close", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const { start, stopped } = starter(["HYPERDRIVE"]);
        const plugin = localHyperdrive({ projectRoot: "/project/slow-config", start });

        await runConfigHook(plugin, "serve");
        // Other plugins' config hooks and the framework setup run before the server exists.
        await vi.advanceTimersByTimeAsync(20_000);

        expect(stopped).toStrictEqual([]);

        attachServer(plugin);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(stopped).toStrictEqual([]);
    });

    it("stops the databases of a config that never got a server, after the longer countdown", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const { start, stopped } = starter(["HYPERDRIVE"]);
        const plugin = localHyperdrive({ projectRoot: "/project/no-server", start });

        await runConfigHook(plugin, "serve");
        await vi.advanceTimersByTimeAsync(29_000);

        expect(stopped).toStrictEqual([]);

        await vi.advanceTimersByTimeAsync(2000);

        expect(stopped).toStrictEqual(["HYPERDRIVE"]);
    });

    it("starts a fresh database for a later session once the first one's were stopped", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        const { start } = starter(["HYPERDRIVE"], ["HYPERDRIVE"]);
        const plugin = localHyperdrive({ projectRoot: "/project/again", start });

        await runConfigHook(plugin, "serve");
        attachServer(plugin)();
        await vi.advanceTimersByTimeAsync(10_000);
        await runConfigHook(plugin, "serve");

        expect(start).toHaveBeenCalledTimes(2);
    });

    it("prints a warning the starter hands it, without failing the dev server", async () => {
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const start = vi.fn<Start>(async ({ onWarning }) => {
            onWarning?.("install PGlite");

            return undefined;
        });

        await expect(runConfigHook(localHyperdrive({ projectRoot: "/project/warn", start }), "serve")).resolves.toBeUndefined();
        expect(warn.mock.calls.flat().join(" ")).toContain("install PGlite");
    });
});
