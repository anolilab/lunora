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
